import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { DATABASE } from '../../src/database/database.module.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
  type CompactionRequest,
} from '../../src/engine/analytical-engine.port.js';
import { PgUnitOfWork } from '../../src/shared/infrastructure/postgres/pg-unit-of-work.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A roll-up writes its files outside any transaction, then publishes them in
 * a short one. These are the things that can happen in between.
 */
let world: World;
let engine: AnalyticalEngine;
let original: AnalyticalEngine['compact'];

beforeAll(async () => {
  world = await makeWorld();
  engine = world.app.get<AnalyticalEngine>(ANALYTICAL_ENGINE, { strict: false });
  original = engine.compact.bind(engine);
});

afterEach(() => {
  engine.compact = original;
});

afterAll(async () => {
  await world?.close();
  await closeDatabase();
});

/** Runs `during` after the roll-up has read the overlay and before it publishes. */
function whileWriting(during: () => Promise<void>): void {
  engine.compact = async (request: CompactionRequest) => {
    await during();
    return original(request);
  };
}

const mapping = {
  table: 'notes',
  rows: '$[*]',
  columns: { n: { from: '$.n', type: ColumnType.Integer } },
};

async function ingotWith(ns: readonly number[]): Promise<string> {
  const ingot = await world.ingot();
  await world.add(ingot, { ...mapping, result: ns.map((n) => ({ n })) });
  return ingot;
}

async function ns(ingot: string): Promise<number[]> {
  const rows = await world.sql(ingot, 'SELECT n FROM notes ORDER BY n');
  return rows.map((row) => Number(row.n));
}

describe('publishing a roll-up', () => {
  it('holds no transaction while DuckDB writes and uploads', async () => {
    const ingot = await ingotWith([1]);
    const uow = world.app.get(PgUnitOfWork, { strict: false });
    const database = world.app.get(DATABASE, { strict: false });
    const seen: { inTransaction?: boolean } = {};
    whileWriting(async () => {
      seen.inTransaction = uow.queryable !== database;
    });

    await world.compact(ingot, 'notes');

    expect(seen.inTransaction).toBe(false);
  });

  it('keeps a write that committed after the read, even below the watermark', async () => {
    const ingot = await ingotWith([1, 2]);
    const { pool } = await openDatabase();
    const {
      rows: [table],
    } = await pool.query<{ id: string; ingot_id: string }>(
      `SELECT id, ingot_id FROM ingot_table WHERE ingot_id = $1 AND name = 'notes'`,
      [ingot],
    );
    if (!table) throw new Error('no notes table');

    // Takes its sequence now, and stays invisible until it commits.
    const late = await pool.connect();
    await late.query('BEGIN');
    await late.query(
      `INSERT INTO overlay_row (ingot_id, table_id, row_id, payload, ingested_at)
       VALUES ($1, $2, 'row_late', $3, now())`,
      [
        table.ingot_id,
        table.id,
        JSON.stringify({ _row_id: 'row_late', _ingested_at: new Date(), _batch: 'b', n: 3 }),
      ],
    );
    // A later write commits first, so the roll-up's watermark is above the
    // late row's sequence.
    await world.add(ingot, { ...mapping, result: [{ n: 4 }] });
    whileWriting(async () => {
      await late.query('COMMIT');
    });

    try {
      await world.compact(ingot, 'notes');
    } finally {
      late.release();
    }

    const notes = (await world.info(ingot)).tables.find((t) => t.name === 'notes');
    expect(notes).toMatchObject({ generation: 1, pending: 1 });
    expect(await ns(ingot)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a row forgotten while the roll-up was writing forgotten', async () => {
    const ingot = await ingotWith([1, 2, 3]);
    whileWriting(async () => {
      expect(await world.forget(ingot, 'notes', 'n = 2')).toBe(1);
    });

    await world.compact(ingot, 'notes');
    expect(await ns(ingot)).toEqual([1, 3]);

    // And the next roll-up applies it to the file for good.
    engine.compact = original;
    await world.compact(ingot, 'notes');
    expect(await ns(ingot)).toEqual([1, 3]);
    const notes = (await world.info(ingot)).tables.find((t) => t.name === 'notes');
    expect(notes?.generation).toBe(2);
  });
});
