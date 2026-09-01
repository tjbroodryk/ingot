import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import type { QueryResult } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The property the whole two-tier design rests on.
 *
 * An ingot is Parquet in a bucket plus an overlay in Postgres, and a query
 * unions the two. That is only worth doing if the seam is invisible: the same
 * question must get the same answer whether a row is four seconds old and
 * still in Postgres, or four weeks old and inside a Parquet file, or — the
 * case that actually breaks things — some of each.
 *
 * If this test ever fails, the failure it is reporting is not "compaction has
 * a bug". It is "the answers this service gives depend on when you ask", which
 * is the one thing a memory may not do.
 */
describe('a roll-up', () => {
  let world: World;
  let ingot: string;

  const rows = (count: number, offset = 0) => ({
    table: 'events',
    rows: '$.items[*]',
    columns: {
      n: { from: '$.n', type: ColumnType.Integer },
      kind: { from: '$.kind', type: ColumnType.Varchar },
      at: { from: '$.at', type: ColumnType.Timestamp },
      note: { from: '$.note', type: ColumnType.Varchar, embed: true },
    },
    result: {
      items: Array.from({ length: count }, (_, index) => ({
        n: offset + index,
        kind: (offset + index) % 3 === 0 ? 'error' : 'info',
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, offset + index)).toISOString(),
        note: `event number ${offset + index}`,
      })),
    },
  });

  /** The questions asked either side of every transition. */
  const questions: ReadonlyArray<readonly [string, string]> = [
    ['a count', 'SELECT count(*) AS n FROM events'],
    ['a filter', "SELECT count(*) AS n FROM events WHERE kind = 'error'"],
    ['an ordering', 'SELECT n FROM events ORDER BY n DESC LIMIT 5'],
    ['an aggregate', 'SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY kind'],
    // `at` is a DuckDB keyword, so a caller has to quote it. This service
    // quotes every identifier it emits; a caller's own SQL is their own.
    [
      'a timestamp comparison',
      `SELECT count(*) AS n FROM events WHERE "at" > '2026-01-01 00:00:10'`,
    ],
    ['a system column', 'SELECT count(DISTINCT _row_id) AS n FROM events'],
  ];

  const answers = async (): Promise<Record<string, QueryResult['rows']>> => {
    const collected: Record<string, QueryResult['rows']> = {};
    for (const [label, sql] of questions) {
      collected[label] = (await world.query(ingot, { sql })).rows;
    }
    return collected;
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an events memory');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('gives the same answers before and after', async () => {
    await world.add(ingot, rows(40));
    await world.embedAll();

    const before = await answers();
    await world.compact(ingot, 'events');
    const after = await answers();

    expect(after).toEqual(before);
  });

  it('actually wrote Parquet, rather than doing nothing', async () => {
    // Otherwise the assertion above would pass for a compaction that was
    // silently a no-op, which is the way this test could lie.
    const info = await world.info(ingot);
    const table = info.tables.find((candidate) => candidate.name === 'events');

    expect(table?.generation).toBe(1);
    expect(table?.pending).toBe(0); // the overlay was drained
    expect(table?.rows).toBe(40);

    const files = parquetUnder(world.dataDir);
    expect(files.some((file) => file.includes('gen-000001'))).toBe(true);
  });

  it('answers the same again with rows in both tiers', async () => {
    // The case that actually breaks a union: some rows in Parquet, some still
    // in Postgres, and one query having to see all of them exactly once.
    await world.add(ingot, rows(10, 40));
    await world.embedAll();

    const straddling = await answers();
    expect(Number(straddling['a count']?.[0]?.n)).toBe(50);

    await world.compact(ingot, 'events');
    expect(await answers()).toEqual(straddling);
  });

  it('keeps a forgotten row forgotten across a roll-up', async () => {
    expect(await world.forget(ingot, 'events', 'n < 5')).toBe(5);

    const before = await answers();
    expect(Number(before['a count']?.[0]?.n)).toBe(45);

    await world.compact(ingot, 'events');
    const after = await answers();

    expect(after).toEqual(before);
    // And the tombstone is now spent: the rows are gone from the Parquet
    // itself, not merely filtered out on the way past.
    const info = await world.info(ingot);
    expect(info.tables.find((table) => table.name === 'events')?.rows).toBe(45);
  });

  it('keeps vectors usable after they move into the sibling file', async () => {
    // Vectors live beside the data rather than in it, and the roll-up has to
    // move them without breaking the join back to `_row_id`.
    const ranked = await world.query(ingot, {
      text: 'event number 30',
      table: 'events',
      limit: 3,
    });
    expect(ranked.rows.length).toBeGreaterThan(0);
    expect(ranked.rows[0]).toHaveProperty('score');
  });

  it('does nothing, and says nothing, when there is nothing to roll up', async () => {
    // A sweep over a quiet table must not rewrite Parquet: every tick would
    // otherwise republish an unchanged file and bump the generation forever.
    const before = (await world.info(ingot)).tables.find((table) => table.name === 'events');
    await world.compact(ingot, 'events');
    const after = (await world.info(ingot)).tables.find((table) => table.name === 'events');

    expect(after?.generation).toBe(before?.generation as number);
  });
});

/** Every Parquet file the filesystem store has written, recursively. */
function parquetUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.parquet')) found.push(path);
    }
  };
  walk(root);
  return found;
}
