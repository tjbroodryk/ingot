import { createHash } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { type FileBody, type FileResult, FileStatus } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock, InvariantViolation, newIdValue } from '../../../../shared/domain/index.js';
import {
  Command,
  type ICommandHandler,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import { Metrics, Outcome } from '../../../../observability/index.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { OBJECT_STORE, type ObjectStore, Keys } from '../../../../storage/object-store.port.js';
import { FileMapping } from '../../domain/file-mapping.vo.js';
import { SNIFF_BYTES, isTabular, mediaTypeOf } from '../../domain/formats/detect.js';
import { queryForChunks, queryForFile } from '../../domain/file-tables.js';
import { FILE_QUEUE, type FileQueue } from '../ports/file-queue.port.js';
import {
  FILE_SETTINGS,
  type FileSettings,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
} from '../file-settings.js';
import { BackgroundWork } from '../../../records/application/background.js';

/** The bytes and their envelope, as a multipart part delivered them. */
export interface UploadedBytes {
  readonly filename: string;
  /** What the part declared. Checked against the bytes, never trusted alone. */
  readonly mediaType: string | undefined;
  readonly content: Buffer;
}

/** `POST /api/v1/:account/:ingot/file` */
export class AcceptFile extends Command<FileResult> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly upload: UploadedBytes,
    readonly body: FileBody,
  ) {
    super();
  }
}

/** How long a caller's own handle may be. `/add` bounds `externalId` the same. */
const MAX_EXTERNAL_ID = 200;

/** A filename is a label in a column, not a path — but it is still a column. */
const MAX_FILENAME = 500;

/**
 * The fast half of `/file`: store the bytes, queue the work, hand back the SQL.
 *
 * **Nothing here reads the document**, and that is the design rather than an
 * economy. Parsing a two-hundred-page PDF is seconds to minutes, and
 * `Dispatcher.send` wraps every command in a Postgres transaction over a pool
 * of ten connections — so a handler that parsed would hold a tenth of the pool
 * for the length of a document and starve the queries this service exists to
 * answer, while presenting as a database problem. `FileWorker` does the reading
 * afterwards, with no transaction and no connection held.
 *
 * What this *does* do is refuse everything refusable while the caller is still
 * holding the response. That is the `/add` rule, and it matters more here: at
 * `/add` a bad mapping is a 422 to somebody who can fix it, and at `/file` the
 * work happens in a sweeper minutes later, with nowhere to complain to but a
 * column. So the media type, the size, the extraction mapping and the chunking
 * knobs are all settled here, before a single byte is stored.
 *
 * The response is a promissory note, which is the same thing `receipt: "summary"`
 * hands back and for the same reason: here is how to find this later.
 */
@CommandHandler(AcceptFile)
export class AcceptFileHandler implements ICommandHandler<AcceptFile> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(FILE_QUEUE) private readonly queue: FileQueue,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(FILE_SETTINGS) private readonly settings: FileSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    /**
     * From `RecordsModule`, which `FilesModule` imports for this alone.
     *
     * The import is one-way and stays one-way. The other direction — this
     * class's worker being drained by `BackgroundWork` — goes through the
     * global `FileStoreModule` rather than an import back, which is what keeps
     * the two contexts from depending on each other.
     */
    private readonly background: BackgroundWork,
  ) {}

  async execute(command: AcceptFile): Promise<FileResult> {
    try {
      return await this.accept(command);
    } catch (error) {
      Metrics.FilesAccepted.inc({ outcome: Outcome.Error }, 1);
      throw error;
    }
  }

  private async accept(command: AcceptFile): Promise<FileResult> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);
    const { upload, body } = command;

    const bytes = upload.content.byteLength;
    if (bytes === 0) {
      throw new InvariantViolation(`"${upload.filename}" is empty; there is nothing to parse`);
    }
    if (bytes > this.settings.maxUploadBytes) {
      throw new InvariantViolation(
        `"${upload.filename}" is ${megabytes(bytes)}, and this deployment accepts at most ` +
          `${megabytes(this.settings.maxUploadBytes)}. The bytes are held whole in memory to ` +
          'be parsed, so the ceiling is heap rather than policy — INGOT_MAX_UPLOAD_BYTES ' +
          'raises it.',
      );
    }

    const filename = nameOf(upload.filename);
    // Both halves are consulted and both have to agree. A declared type alone
    // is a caller choosing which decoder runs; four sniffed bytes alone cannot
    // tell a .docx from a .pptx, because every OOXML file is a zip.
    const mediaType = mediaTypeOf({
      declared: upload.mediaType,
      filename,
      head: upload.content.subarray(0, SNIFF_BYTES),
    });

    /*
     * There is no "can this build read it" check here any more, and its absence
     * is the point of the registry.
     *
     * There used to be one: `MediaType` named formats the product understood and
     * a parser's `handles` said which of those it could actually read, so the
     * two could drift and a gap between them had to be caught at runtime — or
     * else discovered by a sweeper, four attempts into a document that was never
     * going to parse.
     *
     * `FORMATS` is a `Record<MediaType, FormatHandler>`, so that gap cannot
     * exist: every name has a handler or the build does not compile.
     * `mediaTypeOf` above already refused anything outside the enum, which means
     * by this line the format is known to be readable.
     */

    // Parsed before anything is stored: a caller who
    // wrote a mapping this service cannot honour should be told now rather
    // than handed a file id whose parse fails in a sweeper.
    const mapping = body.extract
      ? FileMapping.parse(body.extract, { tabular: isTabular(mediaType) })
      : null;

    const chunkTokens = bounded(body.chunkTokens, 'chunkTokens');
    const overlapTokens = bounded(body.overlapTokens, 'overlapTokens');
    if (chunkTokens !== null && overlapTokens !== null && overlapTokens >= chunkTokens) {
      throw new InvariantViolation(
        `"overlapTokens" is ${overlapTokens} and "chunkTokens" is ${chunkTokens}. An overlap ` +
          'has to be smaller than a chunk, or the splitter repeats itself without moving on.',
      );
    }

    const fileId = newIdValue('file');
    const objectKey = Keys.file(ingot.accountId, ingot.id.value, fileId);

    /*
     * The object first, then the row, and the order is the whole of it.
     *
     * Neither half is transactional with the other — an object store has no
     * rollback — so one of the two failure modes has to be chosen deliberately.
     * Writing the object first risks an orphan if the transaction then rolls
     * back: bytes nobody references, under the memory's own prefix, removed
     * with it by the `removePrefix` that already removes the Parquet. Writing
     * the row first risks a queue entry pointing at an object that is not
     * there, which is a parse that fails four times and a document the caller
     * was told had been accepted.
     *
     * An orphan costs storage until the memory is deleted. The other costs a
     * caller a document they believe they uploaded. That is not a close call.
     */
    await this.objects.put(objectKey, upload.content);

    await this.queue.enqueue({
      fileId,
      ingotId: ingot.id.value,
      objectKey,
      filename,
      mediaType,
      bytes,
      sha256: createHash('sha256').update(upload.content).digest('hex'),
      externalId: externalIdOf(body.externalId),
      extract: body.extract ?? null,
      chunkTokens,
      overlapTokens,
      queuedAt: this.clock.now(),
    });

    Metrics.FilesAccepted.inc({ outcome: Outcome.Ok }, 1);

    // Told, rather than left to be found on the next tick. A minute of latency
    // on a document somebody is waiting for is a minute they experience; the
    // sweeper stays as the floor under a wake that never happened.
    this.uow.afterCommit(async () => this.background.wakeFiles());

    return {
      fileId,
      filename,
      mediaType,
      bytes,
      // Always pending, and it cannot be anything else: this returns before
      // the bytes have been read. `query` is what says how it turned out.
      status: FileStatus.Pending,
      query: queryForFile(fileId),
      chunksQuery: queryForChunks(fileId),
      ...(mapping ? { extractingInto: mapping.table.value } : {}),
    };
  }
}

/**
 * The filename, bounded and stripped of any path a client attached.
 *
 * Browsers send a bare name and `curl -F` sends whatever was typed, which may
 * be `../../etc/passwd`. **This is defence in depth and not the defence**: the
 * object key is built by `Keys.file` from an id this service generated, so the
 * filename never reaches a path at all. What this protects is the column and
 * the log line, where a name full of separators is merely confusing.
 */
function nameOf(raw: string): string {
  const bare = raw.split(/[/\\]/).pop() ?? '';
  const trimmed = bare.trim();

  if (trimmed.length === 0) {
    throw new InvariantViolation('The upload has no filename, and a document needs a name');
  }
  return trimmed.length > MAX_FILENAME ? trimmed.slice(0, MAX_FILENAME) : trimmed;
}

/**
 * The caller's own id for this document, or null.
 *
 * Bounded rather than trusted: it is stored in a `VARCHAR` and echoed back.
 * Blank is treated as absent, because a caller sending `""` meant to send
 * nothing.
 */
function externalIdOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_EXTERNAL_ID) {
    throw new InvariantViolation(
      `externalId is ${trimmed.length} characters; at most ${MAX_EXTERNAL_ID}. It is meant to ` +
        'be your handle for this document, not the document.',
    );
  }
  return trimmed;
}

/** A chunking knob, checked against the same bounds the deployment default is. */
function bounded(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < MIN_CHUNK_TOKENS || value > MAX_CHUNK_TOKENS) {
    throw new InvariantViolation(
      `"${field}" is ${value}; it must be a whole number of tokens between ` +
        `${MIN_CHUNK_TOKENS} and ${MAX_CHUNK_TOKENS}.`,
    );
  }
  return value;
}

/** Sizes in the units the person reading the error is thinking in. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
