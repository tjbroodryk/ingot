import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { ColumnType, DeliveryStrategy, FtsConfig } from '@ingot/shared/ingot-v1';

/** How a memory's delivery strategy is stored: the wire shape, unchanged. `Delivery` parses it both ways. */
export type StoredDelivery = DeliveryStrategy;

/** One memory. Thin on purpose — the shape of the data lives on the tables. */
export const ingot = pgTable(
  'ingot',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** The vector space, claimed by the first embedding. Null until then; both columns or neither. */
    embeddingModel: text('embedding_model'),
    embeddingDims: integer('embedding_dims'),
    /** Delivery target as a `DeliveryStrategy` document. Null (unconfigured) reads as `none`. */
    delivery: jsonb('delivery').$type<StoredDelivery>(),
    version: integer('version').notNull(),
  },
  (table) => [
    index('ingot_account').on(table.accountId, table.createdAt),
    // Partial: only rows that can expire.
    index('ingot_expiring')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
  ],
);

/** How a column is stored in the manifest's `columns` document. */
export interface StoredColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly embedded: boolean;
  readonly required: boolean;
}

/** How a table's settings are stored: a document, not a column each. Null reads as the defaults. */
export interface StoredConfig {
  readonly fts?: Partial<FtsConfig>;
}

/** One Parquet object of the base tier. */
export interface StoredFile {
  readonly key: string;
  readonly rows: number;
  readonly bytes: number;
}

/**
 * The manifest, per table. `(ingot_id, name)` is a unique index; the primary key
 * is a synthetic id. No FK to `ingot`; tables are deleted in the same transaction.
 */
export const ingotTable = pgTable(
  'ingot_table',
  {
    id: text('id').primaryKey(),
    ingotId: text('ingot_id').notNull(),
    name: text('name').notNull(),
    columns: jsonb('columns').$type<StoredColumn[]>().notNull(),
    // `key_columns`, not `key`: KEY is reserved in many SQL dialects.
    keyColumns: jsonb('key_columns').$type<string[]>().notNull(),
    baseFiles: jsonb('base_files').$type<StoredFile[]>().notNull(),
    vectorFiles: jsonb('vector_files').$type<StoredFile[]>().notNull(),
    generation: integer('generation').notNull(),
    baseRows: integer('base_rows').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    // Nullable, not defaulted: unconfigured reads the code's defaults.
    config: jsonb('config').$type<StoredConfig>(),
    version: integer('version').notNull(),
  },
  (table) => [
    unique('ingot_table_name').on(table.ingotId, table.name),
    index('ingot_table_ingot').on(table.ingotId),
  ],
);

export type IngotRow = typeof ingot.$inferSelect;
export type IngotTableRow = typeof ingotTable.$inferSelect;
