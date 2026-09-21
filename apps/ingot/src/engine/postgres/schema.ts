import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** The shared Parquet cache's index. See `drizzle/0014_parquet_cache.sql`. */
export const parquetCacheFile = pgTable(
  'parquet_cache_file',
  {
    id: text('id').primaryKey(),
    objectKey: text('object_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('parquet_cache_file_last_used').on(table.lastUsedAt)],
);
