import { bigint, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { FileExtraction } from '@ingot/shared/ingot-v1';

/**
 * Documents accepted and not yet parsed. One row per `/file`; the bytes are in
 * the object store, keyed by `objectKey`.
 *
 * `claimedAt` is a lease, not a row lock, since the parse runs outside the
 * transaction. `attempts` is incremented at claim, so an input that kills the
 * worker still bounds the retrying; `lastError` is only the explanation.
 */
export const fileQueue = pgTable(
  'file_queue',
  {
    fileId: text('file_id').primaryKey(),
    ingotId: text('ingot_id').notNull(),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    // `bigint` column, JS number here: the size cap keeps it inside MAX_SAFE_INTEGER.
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    externalId: text('external_id'),
    // The caller's mapping, kept whole and replayed verbatim; never queried into.
    extract: jsonb('extract').$type<FileExtraction>(),
    chunkTokens: integer('chunk_tokens'),
    overlapTokens: integer('overlap_tokens'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('file_queue_age').on(table.attempts, table.claimedAt, table.queuedAt),
    index('file_queue_ingot').on(table.ingotId),
  ],
);
