import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { IngotTableId } from '../../src/contexts/ingots/domain/index.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Several agents writing to one memory at the same moment.
 *
 * This is the normal case for this product, not an edge one — an ingot is
 * shared by whatever is storing into it — and it was broken. A k6 run at 100
 * requests/second turned up a steady 1.2% of 500s, all of them the same thing:
 * two writes to a table that did not exist yet both created it, collided on the
 * `(ingot_id, name)` index, and raised a constraint violation that aborted the
 * transaction. Nothing in the suite went anywhere near it, because every test
 * here wrote one thing at a time.
 *
 * So these run concurrently on purpose. A version of this file that awaited
 * each write in turn would pass against the bug it was written for.
 */
describe('many writers, one table', () => {
  let world: World;

  beforeAll(async () => {
    world = await makeWorld();
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  const mapping = (n: number) => ({
    table: 'racing',
    columns: {
      n: { from: '$.n', type: ColumnType.Integer },
      body: { from: '$.body', type: ColumnType.Varchar },
    },
    result: { n, body: `row ${n}` },
  });

  it('all succeed when the table does not exist yet', async () => {
    const ingot = await world.ingot('a contended memory');

    // Every one of these finds no table and tries to create it. Exactly one
    // wins the insert; the rest have to notice that and use what it made.
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, n) => world.add(ingot, mapping(n))),
    );

    expect(results).toHaveLength(24);
    expect(results.every((result) => result.rowsAdded === 1)).toBe(true);

    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM racing');
    expect(Number(rows[0]?.n)).toBe(24);
  });

  it('creates exactly one table, not one per writer', async () => {
    const ingot = await world.ingot('another contended memory');
    await Promise.all(Array.from({ length: 12 }, (_, n) => world.add(ingot, mapping(n))));

    const info = await world.info(ingot);
    expect(info.tables.map((table) => table.name)).toEqual(['racing']);
  });

  it('derives a table’s id from the ingot and the name', () => {
    // This is what turns the collision from a raw constraint violation — which
    // aborts the transaction and cannot be recovered in place — into an
    // ordinary version miss the loser can re-read past.
    const first = IngotTableId.forTable('ing_abc', 'racing');
    expect(IngotTableId.forTable('ing_abc', 'racing').value).toBe(first.value);
    expect(IngotTableId.forTable('ing_abc', 'other').value).not.toBe(first.value);
    expect(IngotTableId.forTable('ing_xyz', 'racing').value).not.toBe(first.value);
    expect(first.value).toMatch(/^tbl_[0-9a-f]{24}$/);
  });

  it('does not contend once the schema has settled', async () => {
    // The other half of the fix. Every /add used to save the manifest whether
    // or not anything about it had changed, so concurrent writes to a stable
    // table fought over its version for no reason. The steady state of this
    // product is a fixed schema and a great many rows.
    const ingot = await world.ingot('a busy memory');
    await world.add(ingot, mapping(0));

    const before = await world.info(ingot);
    await Promise.all(Array.from({ length: 32 }, (_, n) => world.add(ingot, mapping(n + 1))));
    const after = await world.info(ingot);

    // The manifest did not move, so nothing could have contended on it.
    expect(after.tables[0]?.generation).toBe(before.tables[0]?.generation as number);
    expect(Number((await world.sql(ingot, 'SELECT count(*) AS n FROM racing'))[0]?.n)).toBe(33);
  });

  it('still widens the schema when a concurrent write introduces a column', async () => {
    const ingot = await world.ingot('a widening memory');

    // The table is created first, on its own. Racing the *creation* would make
    // this test order-dependent: whichever writer wins declares the schema, so
    // whether `extra` is an original column or an added one would be a coin
    // toss. What is worth asserting is the widening, so that is what is raced.
    await world.add(ingot, mapping(0));

    await Promise.all([
      world.add(ingot, mapping(1)),
      world.add(ingot, {
        ...mapping(2),
        columns: { ...mapping(2).columns, extra: { value: 'x', type: ColumnType.Varchar } },
      }),
      world.add(ingot, mapping(3)),
    ]);

    const info = await world.info(ingot);
    const columns = info.tables[0]?.columns.map((column) => column.name) ?? [];
    expect(columns).toContain('extra');
    // Added after rows existed, so it cannot be required — the rows already
    // written have no such column and never will.
    expect(info.tables[0]?.columns.find((c) => c.name === 'extra')?.required).toBe(false);
    expect(Number((await world.sql(ingot, 'SELECT count(*) AS n FROM racing'))[0]?.n)).toBe(4);
  });
});
