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
import { isTabular } from '../../domain/media-type.js';
import {
  CHUNKS_TABLE,
  CHUNK_FILE_ID,
  CHUNK_KIND,
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
  /**
   * What an extraction pulled out, as JSON, before any mapping runs.
   *
   * A blob rather than rows, because the projection from a blob to typed
   * columns is `RowMapping` and running it here is the whole point — the same
   * paths, the same coercion and the same 422-shaped complaint an `/add` would
   * have made about the same mapping.
   */
  readonly extracted: unknown | null;
}

/**
 * Stores everything one document became — the file row, its chunks, and the
 * typed rows an extraction pulled out.
 *
 * The last of three, and it takes the result rather than producing it: the
 * parse happened outside any transaction, precisely so this one is short.
 * Everything here is Postgres, and it is **one transaction over all three
 * writes** rather than three commands, which matters more than it looks.
 *
 * Splitting them would leave a window in which chunks are written and the
 * extracted rows are not, and a retry after that window writes the chunks
 * again. A chunk table is keyed on `(file_id, ordinal)` and **nothing in this
 * service enforces a key** — declaring one says "this is what identifies the
 * thing", not "refuse a second" — so the duplicates would simply sit there,
 * both ranking, in every search over that memory afterwards. One transaction is
 * what makes a retry a retry rather than a doubling.
 */
export class WriteFile extends Command<void> {
  constructor(
    readonly job: PendingFile,
    readonly read: ReadDocument,
  ) {
    super();
  }
}

/**
 * Documents whose parse was abandoned still get a row, and this is the flag
 * that says so.
 *
 * A deliberate improvement on what an abandoned *receipt* does. There, the
 * caller is left holding a SELECT that will always come back empty and the only
 * evidence is a gauge an operator has to be watching. Here the caller was
 * handed two queries and at least one of them can answer honestly: `status` is
 * `failed`, `error` says what happened, and nobody has to guess whether their
 * upload is slow or dead.
 */
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
    const table = await this.registry.ensure(job.ingotId, FILES_TABLE, () =>
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

    // Through the ordinary overlay, which is the whole point of `ingot_files`
    // being a table: this queues the title and summary for embedding, the
    // roll-up folds the row into Parquet, and `/query` unions the tiers.
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

    const table = await this.registry.ensure(job.ingotId, CHUNKS_TABLE, () =>
      declareChunksTable(job.ingotId, now),
    );

    const batch = newIdValue('batch');
    const rows = chunks.map((piece) => ({
      [ROW_ID]: newIdValue('row'),
      [INGESTED_AT]: now.toISOString(),
      // One batch for the whole document, so `WHERE _batch = …` collects
      // exactly the chunks one upload produced — the same grain an `/add`
      // receipt's batch query has.
      [BATCH]: batch,
      [CHUNK_FILE_ID]: job.fileId,
      [CHUNK_ORDINAL]: piece.ordinal,
      [CHUNK_TEXT]: piece.text,
      [CHUNK_KIND]: piece.kind as ChunkKind as string,
      [CHUNK_TOKENS]: piece.tokens,
      [CHUNK_PAGE]: piece.page,
      [CHUNK_SECTION]: piece.section,
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
   * **This is the join between the two halves of the feature, and it is
   * deliberately three lines.** Once a document has become JSON — by a parser
   * reading a header row, or by a model answering a schema — everything left to
   * do is precisely an `/add`: project through declared paths, coerce to
   * declared types, widen the table if a column is new, refuse a type that
   * moved. Reimplementing any of that here would be a second projection with
   * its own opinions, and the two would drift.
   *
   * The mapping is re-parsed rather than carried on the queue row for the
   * reason the delivery outbox rebuilds nothing: what is stored is the caller's
   * document, and `FileMapping` is the thing that knows how to read it. It was
   * already parsed once at upload, which is where a bad one was refused.
   */
  private async writeExtracted(job: PendingFile, extracted: unknown, now: Date): Promise<void> {
    const mapping = FileMapping.parse(job.extract as NonNullable<typeof job.extract>, {
      // Recomputed from the media type rather than carried on the queue row: it
      // is a fact about the format, and a format does not change under a stored
      // document. This reaches the same answer the upload did, the same way.
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

    // The same two checks `/add` makes, in the same order, because this write
    // is an `/add` in everything but where the JSON came from. A caller whose
    // extraction contradicts a table they have been filling by hand gets the
    // same refusal — recorded on the document rather than returned, since this
    // runs long after they let go of the response.
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

    // Always, so the reason is in front of whoever goes looking at the queue,
    // and so the lease is cleared for a retry that is still owed.
    await this.queue.fail(job.fileId, reason);
    if (!command.terminal) return;

    /*
     * The last attempt writes a row, which is the thing an abandoned receipt
     * cannot do.
     *
     * The row leaves the queue in place rather than removing it: the queue row
     * is what `ingot_files_abandoned` counts, and an operator losing sight of a
     * document the moment it is given up on is exactly the wrong outcome. The
     * caller gets an answer and the deployment keeps its evidence.
     */
    const now = this.clock.now();
    const table = await this.registry.ensure(job.ingotId, FILES_TABLE, () =>
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
