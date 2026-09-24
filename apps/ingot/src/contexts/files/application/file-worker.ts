import { Inject, Injectable, Logger } from '@nestjs/common';
import { OCR, type Ocr } from '../../../ai/ocr.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { errorMessage } from '../../../shared/error-message.js';
import { OBJECT_STORE, type ObjectStore } from '../../../storage/object-store.port.js';
import type { Drained } from '../../records/application/drained.js';
import { chunk } from '../domain/chunker.js';
import { PARSE_TIMEOUT_MS } from '../domain/format.js';
import { isTabular } from '../domain/formats/detect.js';
import { handlerFor } from '../domain/formats/index.js';
import { ClaimFile, MAX_FILE_ATTEMPTS } from './commands/claim-file.command.js';
import { FailFile, type ReadDocument, WriteFile } from './commands/write-file.command.js';
import { FILE_SETTINGS, type FileSettings } from './file-settings.js';
import type { PendingFile } from './ports/file-queue.port.js';

/** Documents one drain will read. */
const PASSES = 2;

/**
 * Reads one document: claim, fetch, parse, chunk, write.
 *
 * A service, not a command: the parse runs between `ClaimFile` and `WriteFile`
 * with no transaction or connection held. Must not be called from inside a
 * command, or the dispatches join that transaction.
 */
@Injectable()
export class FileWorker {
  private readonly logger = new Logger(FileWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(FILE_SETTINGS) private readonly settings: FileSettings,
    // Null unless an OCR engine is configured; without one, a blank page stays blank.
    @Inject(OCR) private readonly ocr: Ocr | null,
  ) {}

  /** Works the queue until it is empty or the pass is spent. */
  async drain(): Promise<Drained> {
    let read = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      // Nothing claimed: empty, all leased, or all out of attempts — stop.
      if (!(await this.next())) break;
      read++;
      // Work on the last pass means the queue outlasted this drain.
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

      // The attempt was charged at claim. Whether it was the last decides if a
      // terminal `failed` row is written now.
      const terminal = job.attempts >= MAX_FILE_ATTEMPTS;
      await this.dispatcher.send(new FailFile(job, errorMessage(error), terminal));

      if (terminal) {
        this.logger.warn(
          `Gave up on "${job.filename}" (${job.fileId}) after ${job.attempts} attempts: ` +
            `${errorMessage(error)}. The row in ingot_files says so.`,
        );
      }
    }
    return true;
  }

  /**
   * The expensive middle: fetch, parse, chunk. No transaction, no connection held.
   *
   * Bounded by its own deadline, shorter than the lease so a still-running parse
   * cannot outlive it.
   */
  private async read(job: PendingFile): Promise<ReadDocument> {
    const content = await this.objects.fetch(job.objectKey);

    const parsed = await withDeadline(
      // Total over the media type: there is no "which parser" step.
      handlerFor(job.mediaType).parse({
        content,
        mediaType: job.mediaType,
        filename: job.filename,
        ocr: this.ocr,
      }),
      PARSE_TIMEOUT_MS,
      `Parsing "${job.filename}" took longer than ${PARSE_TIMEOUT_MS / 1000}s`,
    );

    const chunks = chunk({
      blocks: parsed.blocks,
      mediaType: job.mediaType,
      // The caller's knobs where given, the defaults otherwise. The boundary is
      // not a knob — it is decided by the format.
      chunkTokens: job.chunkTokens ?? this.settings.chunkTokens,
      overlapTokens: job.overlapTokens ?? this.settings.overlapTokens,
    });

    return {
      chunks,
      pages: parsed.pages,
      title: parsed.title,
      // A model's précis of the document. Nothing writes it yet, so null.
      summary: null,
      extracted: this.extractedFrom(job, parsed.rows),
    };
  }

  /**
   * What an extraction projects, or null when none was asked for.
   *
   * A tabular document needs no model: its parsed rows are already the JSON an
   * `/add` mapping projects. Prose needs a model, which is not built yet, so it
   * returns null rather than losing the chunks with it.
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

  /** The whole attempt, labelled by `media_type` since durations are bimodal by format. */
  private measure(job: PendingFile, outcome: Outcome, started: number): void {
    Metrics.FileDuration.observe(
      { media_type: job.mediaType, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/**
 * `work`, or a rejection once `ms` elapses.
 *
 * The work is not actually stopped; this bounds how long the worker waits, so
 * it can record the failure before the lease lapses.
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
