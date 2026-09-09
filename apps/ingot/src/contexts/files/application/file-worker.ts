import { Inject, Injectable, Logger } from '@nestjs/common';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { OBJECT_STORE, type ObjectStore } from '../../../storage/object-store.port.js';
import type { Drained } from '../../records/application/drained.js';
import { chunk } from '../domain/chunker.js';
import { isTabular } from '../domain/media-type.js';
import { ClaimFile, MAX_FILE_ATTEMPTS } from './commands/claim-file.command.js';
import { FailFile, type ReadDocument, WriteFile } from './commands/write-file.command.js';
import { FILE_SETTINGS, type FileSettings } from './file-settings.js';
import {
  DOCUMENT_PARSER,
  type DocumentParser,
  PARSE_TIMEOUT_MS,
} from './ports/document-parser.port.js';
import type { PendingFile } from './ports/file-queue.port.js';

/**
 * Documents one drain will read.
 *
 * Two, and it is the smallest bound of any queue in the service on purpose.
 * Each pass here holds a whole document in memory while it parses — a zip is
 * read from its central directory and a PDF from its trailer, so neither
 * streams — and the ceiling that matters is heap rather than somebody else's
 * rate limit. Two documents at `INGOT_MAX_UPLOAD_BYTES` apiece is a number an
 * operator can multiply by `INGOT_FILES_CONCURRENCY` and by their replica count
 * and get an answer they can size a pod against.
 */
const PASSES = 2;

/**
 * Reads one document: claim, fetch, parse, chunk, write.
 *
 * **This is a service and not a command**, for the reason `ReceiptWorker` gives
 * at length and with more force. `Dispatcher.send` opens a Postgres transaction
 * around every command, which is exactly right when a command is the unit of
 * change and exactly wrong for work with a parse in the middle of it. A single
 * `ParseFile` command would hold one of ten pooled connections for the length
 * of a two-hundred-page PDF — tens of seconds — so a handful of concurrent
 * uploads would starve the queries this service exists to answer, and it would
 * present as a database problem.
 *
 * ```
 * ClaimFile   tx ~1ms   leases the row, counts the attempt
 *   fetch → parse → chunk → extract     no transaction, no connection
 * WriteFile   tx ~5ms   the file row, its chunks and any extracted rows
 * ```
 *
 * The middle step is the only one that is allowed to be slow, and everything
 * about the arrangement exists so that it can be. It must never be called from
 * inside a command, or the dispatches join that transaction and the whole point
 * is lost — `PgUnitOfWork.run` joins rather than nests. The sweeper calls it
 * directly, which is why the sweeper does not dispatch it.
 */
@Injectable()
export class FileWorker {
  private readonly logger = new Logger(FileWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(DOCUMENT_PARSER) private readonly parser: DocumentParser,
    @Inject(FILE_SETTINGS) private readonly settings: FileSettings,
  ) {}

  /**
   * Works the queue until it is empty or the pass is spent.
   *
   * The one implementation of "read the documents that are waiting", called by
   * the sweeper on its timer and by `/file` the moment an upload commits — so
   * somebody who has just uploaded something gets it about as fast as it can be
   * parsed, rather than within the minute.
   */
  async drain(): Promise<Drained> {
    let read = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      // Nothing claimed means the queue is empty, everything left is leased by
      // another worker, or everything left has run out of attempts. All three
      // are the same answer: there is nothing to gain from asking again.
      if (!(await this.next())) break;
      read++;
      // Work found on the last pass means the queue outlasted this drain, and
      // another should start now rather than at the next sweep.
      more = pass === PASSES - 1;
    }

    if (read > 0) this.logger.log(`Read ${read} document${read === 1 ? '' : 's'}`);
    return { done: read, more };
  }

  /** Whether there was work. False means the queue is empty or all leased. */
  async next(): Promise<boolean> {
    const job: PendingFile | null = await this.dispatcher.send(new ClaimFile());
    if (!job) return false;

    const started = performance.now();

    try {
      await this.dispatcher.send(new WriteFile(job, await this.read(job)));
      this.measure(job, Outcome.Ok, started);
    } catch (error) {
      this.measure(job, Outcome.Error, started);

      // The attempt was charged at claim, so this one is already spent. Telling
      // `FailFile` whether it was the last is what lets a terminal row be
      // written now rather than never — an abandoned document that answers
      // "failed, and here is why" is the whole difference from an abandoned
      // receipt, which answers nothing at all.
      const terminal = job.attempts >= MAX_FILE_ATTEMPTS;
      await this.dispatcher.send(new FailFile(job, message(error), terminal));

      if (terminal) {
        this.logger.warn(
          `Gave up on "${job.filename}" (${job.fileId}) after ${job.attempts} attempts: ` +
            `${message(error)}. The row in ingot_files says so.`,
        );
      }
    }
    return true;
  }

  /**
   * The expensive middle, with no transaction and no connection held.
   *
   * Bounded by its own deadline rather than left to run, and the relationship
   * to the lease is the point: a parse still going when `CLAIM_LEASE_MS` lapses
   * is a document a second replica may claim and parse as well. Two minutes
   * against a five-minute lease leaves room for the write afterwards.
   */
  private async read(job: PendingFile): Promise<ReadDocument> {
    const content = await this.objects.fetch(job.objectKey);

    const parsed = await withDeadline(
      this.parser.parse({ content, mediaType: job.mediaType, filename: job.filename }),
      PARSE_TIMEOUT_MS,
      `Parsing "${job.filename}" took longer than ${PARSE_TIMEOUT_MS / 1000}s`,
    );

    const chunks = chunk({
      blocks: parsed.blocks,
      mediaType: job.mediaType,
      // The caller's knobs where they gave them, this deployment's otherwise.
      // Which boundary the document is split on is not among them — that is
      // decided by what it is, in `STRATEGIES`.
      chunkTokens: job.chunkTokens ?? this.settings.chunkTokens,
      overlapTokens: job.overlapTokens ?? this.settings.overlapTokens,
    });

    return {
      chunks,
      pages: parsed.pages,
      title: parsed.title,
      // A model's précis of the whole document, and the rung above this one.
      // Nothing writes it yet, so it is null and the column is nullable — a
      // deployment with no summariser should still get everything else.
      summary: null,
      extracted: this.extractedFrom(job, parsed.rows),
    };
  }

  /**
   * What an extraction has to project, or null when none was asked for.
   *
   * **A tabular document needs no model here at all**, and that is the whole
   * reason `isTabular` exists. A CSV arrives from the parser as an array of
   * objects keyed by its own header row, which is already the JSON blob an
   * `/add` mapping projects — so the paths a caller wrote resolve against it
   * directly, exactly and for free.
   *
   * Prose is the case that needs a model, and that rung is not built yet: a
   * document with a `describe`-driven extraction parses and chunks, and its
   * extraction produces nothing until `ModelExtractor` lands. Returning null
   * rather than throwing is deliberate — losing the chunks as well would make
   * the missing half take the working half down with it.
   */
  private extractedFrom(
    job: PendingFile,
    rows: readonly Record<string, unknown>[] | null,
  ): unknown | null {
    if (!job.extract) return null;
    if (isTabular(job.mediaType)) return rows ?? [];

    this.logger.warn(
      `"${job.filename}" asked for an extraction from prose, which needs a model this build ` +
        'does not have yet. Its chunks are written; the extracted table is not.',
    );
    return null;
  }

  /**
   * The whole attempt, not just the parse, and labelled by what it was.
   *
   * `media_type` is a label because the distribution is genuinely bimodal: a
   * Markdown file is milliseconds and a large PDF is tens of seconds, so one
   * unlabelled series over both has a p99 that describes neither.
   */
  private measure(job: PendingFile, outcome: Outcome, started: number): void {
    Metrics.FileDuration.observe(
      { media_type: job.mediaType, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/**
 * A promise, or a refusal that says what ran long.
 *
 * The parse is not actually stopped — nothing in a synchronous decoder can be —
 * so this bounds how long the *worker* waits rather than how long the work
 * takes. That is still the property that matters: the lease is what a second
 * replica respects, and a worker that has stopped waiting is one that will
 * record the failure and move on before that lease lapses.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}
