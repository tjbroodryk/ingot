import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tenants. `slug` is unique because it is addressable — it is the first
 * segment of every route in the service.
 */
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
 * Credentials, as digests.
 *
 * `digest` is unique across the whole table, not merely within an account:
 * that is what makes authentication one indexed lookup rather than a scan, and
 * it also means two accounts cannot end up sharing a key even in principle.
 *
 * There is deliberately no index on `revoked_at`. Revoked keys are walked and
 * rejected rather than filtered out in SQL, so that "revoked" and "never
 * existed" take the same time to answer.
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
