import { type SQL, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { ColumnType, DeliveryStrategy, FtsConfig } from '@ingot/shared/ingot-v1';

/**
 * How a memory's delivery strategy is stored: the wire shape, unchanged.
 *
 * The same document a caller sent and the same one `/info` reports, so there is
 * no third representation to keep in step. `Delivery` parses it on the way in
 * and on the way back out, which is what makes storing it verbatim safe.
 */
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
    /**
     * The vector space this memory's embeddings live in, claimed by the first
     * one written and held to from then on. Null for a memory that has never
     * embedded anything — which is most of them, since `embed` is opt-in per
     * column. Both or neither; `useEmbedding` is what keeps them together.
     */
    embeddingModel: text('embedding_model'),
    embeddingDims: integer('embedding_dims'),
    /**
     * Where this memory's receipts are pushed, as a `DeliveryStrategy`
     * document. Null for every memory written before delivery existed and for
     * every one nobody has configured since; `Delivery.rehydrate` reads both as
     * `none`. A document rather than a column per kind, so the next transport
     * is a variant in the code rather than two more nullable columns.
     */
    delivery: jsonb('delivery').$type<StoredDelivery>(),
    version: integer('version').notNull(),
  },
  (table) => [
    index('ingot_account').on(table.accountId, table.createdAt),
    // Partial, because the overwhelming majority of memories never expire and
    // the reaper's query is only ever interested in the ones that do.
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

/**
 * How a table's settings are stored.
 *
 * A document rather than a column each, because these are knobs on how the
 * data is *read* — adding one should not be a migration, and none of them is
 * ever selected on. Null for every table written before this existed, which
 * `TableConfig.rehydrate` reads as the defaults.
 */
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
 * The manifest, per table.
 *
 * `(ingot_id, name)` is the natural key and carries a unique index, but the
 * primary key is a synthetic id: the aggregate has its own version, and the
 * optimistic-concurrency write guards on a single column.
 *
 * There is no foreign key from here to `ingot`. Deleting an ingot deletes its
 * tables in the same transaction, and a cascade would make that implicit
 * rather than a thing the repository is seen to do.
 */
export const ingotTable = pgTable(
  'ingot_table',
  {
    id: text('id').primaryKey(),
    ingotId: text('ingot_id').notNull(),
    name: text('name').notNull(),
    columns: jsonb('columns').$type<StoredColumn[]>().notNull(),
    // `key_columns`, not `key`: KEY is reserved in enough dialects that the
    // shorter name is a trap for whoever writes the next raw query.
    keyColumns: jsonb('key_columns').$type<string[]>().notNull(),
    baseFiles: jsonb('base_files').$type<StoredFile[]>().notNull(),
    vectorFiles: jsonb('vector_files').$type<StoredFile[]>().notNull(),
    generation: integer('generation').notNull(),
    baseRows: integer('base_rows').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    // Nullable rather than defaulted: a table nobody has configured should be
    // reading the *code's* defaults, and a default written into the row is one
    // that goes on claiming a value the code has since moved on from.
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

/** `jsonb` needs the cast spelled out when a document is written as a literal. */
export function asJsonb<T>(value: T): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}
