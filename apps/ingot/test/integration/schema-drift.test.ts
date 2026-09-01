import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import * as schema from '../../src/database/schema.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * Two hand-written descriptions of the same schema, held to each other.
 *
 * The migrations are the truth Postgres runs on; the Drizzle tables are the
 * truth the code compiles against. Nothing generates one from the other — that
 * is a deliberate choice, so migrations can carry comments and be idempotent —
 * which means the only thing stopping them drifting is this.
 *
 * The drift is silent until it is not: a column added to `schema.ts` and not
 * to a migration compiles, deploys, and fails on the first insert.
 */
describe('the Drizzle schema and the database', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ pool } = await openDatabase());
  });

  afterAll(closeDatabase);

  // Not a type predicate: the exports are each their own narrow
  // `PgTableWithColumns<…>` literal type, and a predicate widening them to
  // `PgTable` is not assignable back. The runtime check is the real one.
  const tables = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];

  it('describes some tables at all', () => {
    // Otherwise the loop below is vacuous, which is how this stops testing.
    expect(tables.length).toBeGreaterThan(5);
  });

  it.each(tables.map((table) => [getTableName(table), table] as const))(
    '%s exists with the columns the code expects',
    async (name, table) => {
      const actual = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );

      expect(actual.rowCount).toBeGreaterThan(0);

      const inDatabase = new Set(actual.rows.map((row) => row.column_name));
      const declared = Object.values(getTableColumns(table)).map((column) => column.name);

      const missing = declared.filter((column) => !inDatabase.has(column));
      expect({ table: name, missing }).toEqual({ table: name, missing: [] });
    },
  );

  it('has no table in the database that the code does not know about', async () => {
    const actual = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );

    const declared = new Set<string>(tables.map((table) => getTableName(table)));
    const orphans = actual.rows.map((row) => row.table_name).filter((name) => !declared.has(name));

    // A table nothing maps is either a migration nobody finished or a schema
    // export somebody forgot — both worth knowing about.
    expect(orphans).toEqual([]);
  });
});
