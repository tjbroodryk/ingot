import 'reflect-metadata';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { ColumnType, type PendingOperations } from '@ingot/shared/ingot-v1';
import { sessionSql } from '../../../../packages/sdk/src/duckdb/index.js';
import type { TableSnapshot } from '../../../../packages/sdk/src/ingot.js';
import { GetPendingOperations } from '../../src/contexts/records/application/queries/get-pending-operations.query.js';
import { Keys } from '../../src/storage/object-store.port.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A table rebuilt outside the service answers as the service does.
 *
 * `@ingotdb/sdk/duckdb` hands a caller the statements that reassemble a table in
 * their own DuckDB from `/parquet` and `/pending` — which is only worth having
 * if the result is the one `/query` gives. This is `rollup-equivalence.test.ts`
 * with the second session built by somebody else: every declared type, rows in
 * both tiers, and a row forgotten from each.
 */
describe('a session built from a snapshot', () => {
  let world: World;
  let ingot: string;

  const events = (from: number, count: number) => ({
    table: 'events',
    rows: '$.items[*]',
    raw: true,
    columns: {
      n: { from: '$.n', type: ColumnType.Integer },
      big: { from: '$.big', type: ColumnType.BigInt },
      ratio: { from: '$.ratio', type: ColumnType.Double },
      ok: { from: '$.ok', type: ColumnType.Boolean },
      at: { from: '$.at', type: ColumnType.Timestamp },
      day: { from: '$.day', type: ColumnType.Date },
      meta: { from: '$.meta', type: ColumnType.Json },
      note: { from: '$.note', type: ColumnType.Varchar, embed: true },
    },
    result: {
      items: Array.from({ length: count }, (_, at) => ({
        n: from + at,
        big: 9_000_000_000 + from + at,
        ratio: (from + at) / 7,
        ok: (from + at) % 2 === 0,
        at: new Date(Date.UTC(2026, 8, 1, 12, 0, from + at, 250)).toISOString(),
        day: `2026-09-${String(1 + ((from + at) % 28)).padStart(2, '0')}`,
        meta: { tags: ['a', "it's"], depth: from + at },
        note: `event number ${from + at}, with "quotes" and a ' too`,
      })),
    },
  });

  /** What a caller assembles through the SDK, read here without HTTP. */
  const snapshot = async (): Promise<TableSnapshot> => {
    const rows: PendingOperations['rows'][number][] = [];
    let page: PendingOperations | null = null;
    let after: string | undefined;
    do {
      page = await world.dispatcher.ask(
        new GetPendingOperations(ingot, world.accountId, 'events', { after, limit: 2 }),
      );
      rows.push(...page.rows);
      after = page.next ?? undefined;
    } while (after);

    const info = await world.info(ingot);
    return {
      table: 'events',
      generation: page.generation,
      base: page.base,
      columns: info.tables.find((table) => table.name === 'events')?.columns ?? [],
      rows,
      tombstones: page.tombstones,
      cursor: rows.at(-1)?.seq ?? null,
    };
  };

  const local = async (sql: string): Promise<Record<string, unknown>[]> => {
    const snap = await snapshot();
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const statements = sessionSql(snap, {
        url: (file) =>
          join(
            world.dataDir,
            Keys.part(world.accountId, ingot, file.table, file.generation, file.part),
          ),
      });
      for (const statement of statements) await connection.run(statement);
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson();
    } finally {
      connection.closeSync();
    }
  };

  const ALL = 'SELECT * FROM events ORDER BY n';

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an ingot mirrored elsewhere');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('matches /query while every row is still in the overlay', async () => {
    await world.add(ingot, events(0, 5));

    expect(await local(ALL)).toEqual([...(await world.query(ingot, { sql: ALL })).rows]);
  });

  it('matches /query across a roll-up, with rows and tombstones in both tiers', async () => {
    await world.compact(ingot, 'events');
    await world.add(ingot, events(5, 4));
    await world.forget(ingot, 'events', 'n IN (1, 6)');

    const served = (await world.query(ingot, { sql: ALL })).rows;
    expect(served.map((row) => row.n)).toEqual([0, 2, 3, 4, 5, 7, 8]);
    expect(await local(ALL)).toEqual([...served]);

    const aggregate =
      'SELECT ok, count(*) AS n, sum(big) AS big, max("at") AS latest FROM events ' +
      'GROUP BY ok ORDER BY ok';
    expect(await local(aggregate)).toEqual([
      ...(await world.query(ingot, { sql: aggregate })).rows,
    ]);
  });

  it('never has an embedding to hand out', async () => {
    await world.embedAll();

    const columns = (await local('DESCRIBE events')).map((row) => row.column_name);
    expect(columns).not.toContain('note_vec');
  });
});
