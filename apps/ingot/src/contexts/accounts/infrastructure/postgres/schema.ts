import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Tenants. `slug` is unique; it is the first path segment of every route. */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull(),
  },
  (table) => [index('account_slug').on(table.slug)],
);

/**
 * Credentials, as digests. `digest` is unique table-wide, making authentication
 * one indexed lookup. No index on `revoked_at`: revoked keys are walked, not filtered.
 */
export const accountKey = pgTable(
  'account_key',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    digest: text('digest').notNull().unique(),
    prefix: text('prefix').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('account_key_account').on(table.accountId)],
);

export type AccountRow = typeof account.$inferSelect;
export type AccountKeyRow = typeof accountKey.$inferSelect;
