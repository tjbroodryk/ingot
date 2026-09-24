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

/** Max length of the external id the caller supplies. */
const MAX_EXTERNAL_ID = 200;

/** Max filename length. */
const MAX_FILENAME = 500;

/**
 * Fast half of `/file`: store the bytes, queue the work, hand back the SQL.
 *
 * Reads nothing; `FileWorker` parses afterwards. Everything refusable — media
 * type, size, mapping, chunking knobs — is settled here before a byte is stored.
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
    /** From `RecordsModule`, which `FilesModule` imports for this alone. */
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
    // Declared type and sniffed bytes both consulted; both must agree.
    const mediaType = mediaTypeOf({
      // The caller's explicit type; still checked against the bytes.
      override: body.mediaType,
      declared: upload.mediaType,
      filename,
      head: upload.content.subarray(0, SNIFF_BYTES),
    });

    // Parsed before anything is stored, so a bad mapping is refused now.
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

    // Object before row: a rollback then leaves an orphan object, rather than a
    // queue row pointing at bytes that were never stored.
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

    // Wake the worker now rather than waiting for the next sweep.
    this.uow.afterCommit(async () => this.background.wakeFiles());

    return {
      fileId,
      filename,
      mediaType,
      bytes,
      // Always pending: this returns before the bytes are read.
      status: FileStatus.Pending,
      query: queryForFile(fileId),
      chunksQuery: queryForChunks(fileId),
      ...(mapping ? { extractingInto: mapping.table.value } : {}),
    };
  }
}

/** The filename, bounded and stripped of any path a client attached. */
function nameOf(raw: string): string {
  const bare = raw.split(/[/\\]/).pop() ?? '';
  const trimmed = bare.trim();

  if (trimmed.length === 0) {
    throw new InvariantViolation('The upload has no filename, and a document needs a name');
  }
  return trimmed.length > MAX_FILENAME ? trimmed.slice(0, MAX_FILENAME) : trimmed;
}

/** The caller's own id for this document, or null. Blank counts as absent. */
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

/** A chunking knob, checked against the same bounds as the default. */
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

/** Bytes as MiB, for error messages. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
