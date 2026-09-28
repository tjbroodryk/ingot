import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

/**
 * Seconds since the earliest value of a timestamp column, 0 over no rows.
 *
 * Aged against the database's clock rather than ours, so a pod with a skewed
 * clock reports the same lag as every other.
 */
export function oldestAge(column: AnyColumn): SQL<number> {
  return sql`coalesce(extract(epoch from now() - min(${column})), 0)::float8`.mapWith(Number);
}
