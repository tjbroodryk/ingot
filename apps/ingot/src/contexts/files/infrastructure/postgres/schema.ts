import { bigint, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { FileExtraction } from '@ingot/shared/ingot-v1';

/**
 * Documents accepted and not yet parsed.
 *
 * One row per `/file`, holding everything a worker needs to read the object and
 * nothing it does not — the bytes are in the object store, keyed by
 * `objectKey`, because a fifty-megabyte deck in a `jsonb` column is the failure
 * `INGOT_STORAGE` refuses to boot without a decision about.
 *
 * `claimedAt` is a lease rather than a row lock, because the work does not
 * happen inside one transaction: a document is claimed, parsed, possibly read
 * by a model, and the rows are written — three steps with the expensive one in
 * the middle and no connection held across it.
 *
 * `attempts` is incremented **at claim**, and this is the queue where that
 * choice earns the most. Every other queue in the service is bounded by
 * somebody else's latency; this one can be killed by its own input. A decoder
 * that a malformed PDF takes down never reaches a failure handler, so a counter
 * written there would never move and that document would be retried until an
 * operator noticed. `lastError` is only the explanation — the count is what
 * bounds the retrying.
 */
export const fileQueue = pgTable(
  'file_queue',
  {
    fileId: text('file_id').primaryKey(),
    ingotId: text('ingot_id').notNull(),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    // `bigint` in Postgres and a JS number here: the size cap keeps this far
    // inside `Number.MAX_SAFE_INTEGER`, and a `bigint` mode would make every
    // arithmetic use of it a conversion for a value that is at most gigabytes.
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    externalId: text('external_id'),
    // The caller's mapping, kept whole. It is replayed verbatim by the worker
    // and this service never queries into it, so normalising it into columns
    // would buy nothing and cost a migration every time the shape widened.
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
