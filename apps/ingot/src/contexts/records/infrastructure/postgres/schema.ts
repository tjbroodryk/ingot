import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type { MappedRow } from '../../domain/row-mapping.vo.js';

/**
 * The hot tier: rows accepted but not yet rolled up.
 *
 * `payload` keys are already the declared column names and the values are
 * already coerced to the declared types — that work happens at `/add`, where
 * the caller can still fix it. So projecting this into DuckDB is mechanical
 * and driven by the manifest, rather than a second round of guessing at JSON.
 *
 * `seq` is the point of the table. Compaction reads to a watermark and deletes
 * to the same watermark, which is what lets a roll-up run while writes are
 * still arriving without swallowing the ones that arrived in between.
 */
export const overlayRow = pgTable(
  'overlay_row',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    ingotId: text('ingot_id').notNull(),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    payload: jsonb('payload').$type<MappedRow>().notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('overlay_row_table_seq').on(table.tableId, table.seq),
    index('overlay_row_ingot').on(table.ingotId),
    unique('overlay_row_identity').on(table.tableId, table.rowId),
  ],
);

/**
 * Forgotten rows.
 *
 * A tombstone rather than a delete because the row may already be in a Parquet
 * file, and Parquet is not edited in place. Every read filters against this set
 * and roll-up is what finally drops the row for good.
 *
 * Row ids are resolved at delete time rather than storing the predicate, so
 * this stays a finite set instead of an ever-growing list of filters that
 * every future query has to evaluate.
 */
export const overlayTombstone = pgTable(
  'overlay_tombstone',
  {
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableId, table.rowId] })],
);

/**
 * Vectors for overlay rows.
 *
 * `real[]` rather than a bytea blob, because the overlay is small by design —
 * anything large has been rolled up into the sibling Parquet, which is where
 * vectors live at rest. `model` and `dims` are recorded so that a change of
 * embedding model is a thing that can be noticed rather than a silent mixing
 * of two vector spaces in one ranking.
 */
export const overlayVector = pgTable(
  'overlay_vector',
  {
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    columnName: text('column_name').notNull(),
    model: text('model').notNull(),
    dims: integer('dims').notNull(),
    vector: real('vector').array().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableId, table.rowId, table.columnName] })],
);

/**
 * What still needs embedding.
 *
 * An explicit queue rather than a left join against `overlay_vector`, because
 * the column to embed differs per table and deriving it would mean joining the
 * manifest into a hot query. A row lands here at `/add` and leaves when its
 * vector is written; `pendingCount()` over it is the gauge that says whether
 * the embedder is keeping up.
 *
 * `claimedAt` is a lease. The embedding itself happens outside the transaction
 * that claimed the row — it has to, because a hosted model is an HTTP round
 * trip and holding a connection across one spends the pool on background work
 * — so a row lock cannot be what stops two workers buying the same vectors.
 * It expires, which is what returns a row abandoned by a worker that died.
 */
export const overlayEmbedQueue = pgTable(
  'overlay_embed_queue',
  {
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    columnName: text('column_name').notNull(),
    text: text('text').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tableId, table.rowId, table.columnName] }),
    index('overlay_embed_queue_age').on(table.claimedAt, table.queuedAt),
  ],
);

/**
 * What still needs describing.
 *
 * One row per `/add` that asked for `receipt: "summary"`, holding the tool
 * result until a model has read it. The body is kept here rather than re-read
 * from the overlay because a mapping projects a blob into columns and throws
 * the rest away — `raw: true` is opt-in, and a receipt should not require it.
 *
 * `claimedAt` is a lease rather than a row lock, because the work does not
 * happen inside one transaction: a receipt is claimed, a model is asked, and
 * the answer is written — three steps with a network call between them.
 *
 * `attempts` is incremented **at claim**, not on failure, and that is the
 * difference between a poison body that stops after four tries and one that
 * loops for ever. A worker killed by the very result it is describing never
 * reaches a failure handler, so a counter written there would never move.
 * `lastError` is only the explanation; the count is what bounds the retrying.
 */
export const overlayReceiptQueue = pgTable(
  'overlay_receipt_queue',
  {
    batch: text('batch').primaryKey(),
    externalId: text('external_id'),
    ingotId: text('ingot_id').notNull(),
    tableId: text('table_id').notNull(),
    sourceTable: text('source_table').notNull(),
    body: jsonb('body').notNull(),
    rows: integer('rows').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('overlay_receipt_queue_age').on(table.attempts, table.claimedAt, table.queuedAt),
    index('overlay_receipt_queue_ingot').on(table.ingotId),
  ],
);

export type OverlayRowRecord = typeof overlayRow.$inferSelect;
