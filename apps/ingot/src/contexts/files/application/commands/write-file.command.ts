import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { type ChunkKind, FileStatus } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock, newIdValue } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { Metrics } from '../../../../observability/index.js';
import {
  BATCH,
  INGESTED_AT,
  IngotTable,
  ROW_ID,
} from '../../../ingots/domain/index.js';
import { TableRegistry } from '../../../ingots/application/table-registry.js';
import type { Coerced } from '../../../records/domain/coercion.js';
import { RowMapping } from '../../../records/domain/row-mapping.vo.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import type { Chunk } from '../../domain/chunker.js';
import { FileMapping } from '../../domain/file-mapping.vo.js';
import { isTabular } from '../../domain/formats/detect.js';
import {
  CHUNKS_TABLE,
  CHUNK_FILE_ID,
  CHUNK_KIND,
  CHUNK_OCR,
  CHUNK_ORDINAL,
  CHUNK_PAGE,
  CHUNK_SECTION,
  CHUNK_TEXT,
  CHUNK_TOKENS,
  FILES_TABLE,
  FILE_BYTES,
  FILE_CHUNKS,
  FILE_ERROR,
  FILE_EXTERNAL_ID,
  FILE_ID,
  FILE_MEDIA_TYPE,
  FILE_NAME,
  FILE_PAGES,
  FILE_SHA256,
  FILE_STATUS,
  FILE_SUMMARY,
  FILE_TITLE,
  declareChunksTable,
  declareFilesTable,
} from '../../domain/file-tables.js';
import { FILE_QUEUE, type FileQueue, type PendingFile } from '../ports/file-queue.port.js';

/** What a worker produced from one document, ready to become rows. */
export interface ReadDocument {
  readonly chunks: readonly Chunk[];
  readonly pages: number | null;
  readonly title: string | null;
  readonly summary: string | null;
  /** What an extraction pulled out, as JSON, before any mapping runs. */
  readonly extracted: unknown | null;
}

/**
 * Stores everything one document became: the file row, its chunks, and any
 * extracted rows.
 *
 * One transaction over all three writes, so a retry rewrites the lot rather
 * than doubling chunks — nothing enforces the `(file_id, ordinal)` key.
 */
export class WriteFile extends Command<void> {
  constructor(
    readonly job: PendingFile,
    readonly read: ReadDocument,
  ) {
    super();
  }
}

/** Writes a `failed` row for a document whose parse was abandoned. */
export class FailFile extends Command<void> {
  constructor(
    readonly job: PendingFile,
    readonly reason: string,
    /** True on the attempt that used the last one up. */
    readonly terminal: boolean,
  ) {
    super();
  }
}

@CommandHandler(WriteFile)
export class WriteFileHandler implements ICommandHandler<WriteFile> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(FILE_QUEUE) private readonly queue: FileQueue,
    private readonly registry: TableRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: WriteFile): Promise<void> {
    const { job, read } = command;
    const now = this.clock.now();

    await this.writeFileRow(job, now, {
      status: FileStatus.Ready,
      pages: read.pages,
      chunks: read.chunks.length,
      title: read.title,
      summary: read.summary,
      error: null,
    });

    await this.writeChunks(job, read.chunks, now);
    if (read.extracted !== null && job.extract) await this.writeExtracted(job, read.extracted, now);

    await this.queue.complete(job.fileId);

    Metrics.ChunksWritten.inc({ media_type: job.mediaType }, read.chunks.length);
  }

  /** The memory's document table, created on its first upload. */
  private async writeFileRow(
    job: PendingFile,
    now: Date,
    state: {
      status: FileStatus;
      pages: number | null;
      chunks: number | null;
      title: string | null;
      summary: string | null;
      error: string | null;
    },
  ): Promise<void> {
    const table = await this.registry.ensureCurrent(job.ingotId, FILES_TABLE, () =>
      declareFilesTable(job.ingotId, now),
    );

    const row: Record<string, Coerced> = {
      [ROW_ID]: newIdValue('row'),
      [INGESTED_AT]: now.toISOString(),
      [BATCH]: newIdValue('batch'),
      [FILE_ID]: job.fileId,
      [FILE_EXTERNAL_ID]: job.externalId,
      [FILE_NAME]: job.filename,
      [FILE_MEDIA_TYPE]: job.mediaType,
      [FILE_BYTES]: job.bytes,
      [FILE_SHA256]: job.sha256,
      [FILE_STATUS]: state.status,
      [FILE_PAGES]: state.pages,
      [FILE_CHUNKS]: state.chunks,
      [FILE_ERROR]: state.error,
      [FILE_TITLE]: state.title,
      [FILE_SUMMARY]: state.summary,
    };

    // Through the ordinary overlay, like any other row.
    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows: [row],
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });
  }

  private async writeChunks(
    job: PendingFile,
    chunks: readonly Chunk[],
    now: Date,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const table = await this.registry.ensureCurrent(job.ingotId, CHUNKS_TABLE, () =>
      declareChunksTable(job.ingotId, now),
    );

    const batch = newIdValue('batch');
    const rows = chunks.map((piece) => ({
      [ROW_ID]: newIdValue('row'),
      [INGESTED_AT]: now.toISOString(),
      // One batch per document, so `WHERE _batch = …` selects one upload's chunks.
      [BATCH]: batch,
      [CHUNK_FILE_ID]: job.fileId,
      [CHUNK_ORDINAL]: piece.ordinal,
      [CHUNK_TEXT]: piece.text,
      [CHUNK_KIND]: piece.kind as ChunkKind as string,
      [CHUNK_TOKENS]: piece.tokens,
      [CHUNK_PAGE]: piece.page,
      [CHUNK_SECTION]: piece.section,
      [CHUNK_OCR]: piece.ocr,
    })) as Record<string, Coerced>[];

    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows,
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });
  }

  /**
   * The extracted rows, through the ordinary `/add` mapping.
   *
   * The mapping is re-parsed from the stored document rather than carried on the
   * queue row; it was already parsed once at upload, where a bad one was refused.
   */
  private async writeExtracted(job: PendingFile, extracted: unknown, now: Date): Promise<void> {
    const mapping = FileMapping.parse(job.extract as NonNullable<typeof job.extract>, {
      // Recomputed from the media type; it is a fact about the format.
      tabular: isTabular(job.mediaType),
    });

    const row = RowMapping.parse({
      table: mapping.table.value,
      rows: mapping.rows ?? undefined,
      key: [...mapping.key],
      columns: mapping.asColumnMappings(),
      result: extracted,
    });

    const table = await this.registry.ensure(job.ingotId, mapping.table.value, () =>
      IngotTable.declare({
        ingotId: job.ingotId,
        name: mapping.table.value,
        columns: row.columns,
        key: mapping.key,
        raw: false,
        now,
      }),
    );

    // The same two checks `/add` makes; a contradiction is recorded on the
    // document rather than returned.
    table.assertKeyUnchanged(mapping.key);
    table.accommodate(row.columns);
    if (table.hasChanges) await this.registry.save(table);

    const applied = row.apply(extracted, {
      rowId: () => newIdValue('row'),
      at: now,
      batch: newIdValue('batch'),
    });

    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows: applied.rows,
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });
  }
}

@CommandHandler(FailFile)
export class FailFileHandler implements ICommandHandler<FailFile> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(FILE_QUEUE) private readonly queue: FileQueue,
    private readonly registry: TableRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: FailFile): Promise<void> {
    const { job, reason } = command;

    // Always: keep the reason and clear the lease for any retry still owed.
    await this.queue.fail(job.fileId, reason);
    if (!command.terminal) return;

    // The last attempt writes a `failed` row; the queue row stays so the
    // abandoned count still sees it.
    const now = this.clock.now();
    const table = await this.registry.ensureCurrent(job.ingotId, FILES_TABLE, () =>
      declareFilesTable(job.ingotId, now),
    );

    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows: [
        {
          [ROW_ID]: newIdValue('row'),
          [INGESTED_AT]: now.toISOString(),
          [BATCH]: newIdValue('batch'),
          [FILE_ID]: job.fileId,
          [FILE_EXTERNAL_ID]: job.externalId,
          [FILE_NAME]: job.filename,
          [FILE_MEDIA_TYPE]: job.mediaType,
          [FILE_BYTES]: job.bytes,
          [FILE_SHA256]: job.sha256,
          [FILE_STATUS]: FileStatus.Failed,
          [FILE_PAGES]: null,
          [FILE_CHUNKS]: null,
          [FILE_ERROR]: reason,
          [FILE_TITLE]: null,
          [FILE_SUMMARY]: null,
        } as Record<string, Coerced>,
      ],
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });
  }
}
