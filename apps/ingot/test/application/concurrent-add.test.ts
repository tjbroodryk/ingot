import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { IngotTableId } from '../../src/contexts/ingots/domain/index.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/** Concurrent writes to one table: creation races and schema widening. */
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

    // Each finds no table and tries to create it; one wins the insert, the
    // rest reuse what it made.
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
    // A deterministic id turns a creation collision into a version miss the
    // loser can re-read past, rather than a constraint violation.
    const first = IngotTableId.forTable('ing_abc', 'racing');
    expect(IngotTableId.forTable('ing_abc', 'racing').value).toBe(first.value);
    expect(IngotTableId.forTable('ing_abc', 'other').value).not.toBe(first.value);
    expect(IngotTableId.forTable('ing_xyz', 'racing').value).not.toBe(first.value);
    expect(first.value).toMatch(/^tbl_[0-9a-f]{24}$/);
  });

  it('does not contend once the schema has settled', async () => {
    // Writes to a stable table must not bump its manifest version.
    const ingot = await world.ingot('a busy memory');
    await world.add(ingot, mapping(0));

    const before = await world.info(ingot);
    await Promise.all(Array.from({ length: 32 }, (_, n) => world.add(ingot, mapping(n + 1))));
    const after = await world.info(ingot);

    expect(after.tables[0]?.generation).toBe(before.tables[0]?.generation as number);
    expect(Number((await world.sql(ingot, 'SELECT count(*) AS n FROM racing'))[0]?.n)).toBe(33);
  });

  it('still widens the schema when a concurrent write introduces a column', async () => {
    const ingot = await world.ingot('a widening memory');

    // Table created first, on its own, so `extra` is unambiguously an added
    // column and the race is only over the widening.
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
    // Added after rows existed, so it cannot be required.
    expect(info.tables[0]?.columns.find((c) => c.name === 'extra')?.required).toBe(false);
    expect(Number((await world.sql(ingot, 'SELECT count(*) AS n FROM racing'))[0]?.n)).toBe(4);
  });
});
