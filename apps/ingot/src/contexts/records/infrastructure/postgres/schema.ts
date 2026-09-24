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
 * The hot tier: rows accepted but not yet rolled up. `payload` keys and values
 * are already the declared columns and coerced types, so projecting into DuckDB
 * is mechanical. `seq` is the point: compaction reads and deletes to a watermark.
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
 * Forgotten rows. A tombstone rather than a delete, since the row may be in a
 * Parquet file that is not edited in place; reads filter against this set and
 * roll-up finally drops the row. Ids resolved at delete time keep the set finite.
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
 * Vectors for overlay rows. `real[]` rather than a blob since the overlay is
 * small; anything large has rolled up into Parquet. `model` and `dims` are
 * recorded so a change of embedding model can be noticed.
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
 * What still needs embedding. An explicit queue rather than a join against
 * `overlay_vector`, since the column to embed differs per table. `claimedAt` is
 * a lease that expires, since embedding happens outside the claiming transaction.
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
 * What still needs describing. One row per `/add` that asked for
 * `receipt: "summary"`, holding the tool result until a model reads it.
 * `claimedAt` is a lease; `attempts` is incremented at claim, bounding retries.
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

/**
 * Receipts announced and not yet delivered. The outbox. One row per receipt
 * whose memory has a delivery strategy, written in the receipt's transaction so
 * the two commit together. `target` and `payload` are resolved at enqueue;
 * `claimedAt` is a lease and the claim counts the attempt.
 */
export const receiptDeliveryQueue = pgTable(
  'receipt_delivery_queue',
  {
    /** The receipt's batch: one delivery per receipt, and its identity. */
    batch: text('batch').primaryKey(),
    ingotId: text('ingot_id').notNull(),
    /** A `DeliveryStrategy`: where this was going when it was announced. */
    target: jsonb('target').notNull(),
    /** A `DeliveredReceipt`: the body, rendered when the receipt was written. */
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('receipt_delivery_queue_age').on(table.attempts, table.claimedAt, table.queuedAt),
    index('receipt_delivery_queue_ingot').on(table.ingotId),
  ],
);

export type OverlayRowRecord = typeof overlayRow.$inferSelect;
