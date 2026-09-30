import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../src/contexts/records/application/ports/overlay-store.port.js';
import {
  ROLL_UP_SETTINGS,
  type RollUpSettings,
} from '../../src/contexts/records/application/roll-up-settings.js';
import { ParquetCache } from '../../src/engine/parquet-cache.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import type { Clock } from '../../src/shared/domain/index.js';
import { RollUpSweeper } from '../../src/sweepers/roll-up.sweeper.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * When a table is rolled up: `INGOT_ROLLUP_INTERVAL_MS` after its first write,
 * or as soon as its overlay reaches `INGOT_ROLLUP_MIN_ROWS`.
 */
let world: World;

const MIN_ROWS = 5;
const INTERVAL_MS = 300_000;

beforeAll(async () => {
  world = await makeWorld({
    env: { INGOT_ROLLUP_MIN_ROWS: String(MIN_ROWS), INGOT_ROLLUP_INTERVAL_MS: String(INTERVAL_MS) },
  });
});

afterAll(async () => {
  await world?.close();
  await closeDatabase();
});

function sweeperAt(instant: Date): RollUpSweeper {
  const clock: Clock = { now: () => instant };
  return new RollUpSweeper(
    world.app.get(Dispatcher),
    world.app.get<OverlayStore>(OVERLAY_STORE, { strict: false }),
    world.app.get(ParquetCache, { strict: false }),
    clock,
    world.app.get<RollUpSettings>(ROLL_UP_SETTINGS, { strict: false }),
  );
}

async function ingotWith(rows: number): Promise<string> {
  const ingot = await world.ingot();
  await world.add(ingot, {
    table: 'notes',
    rows: '$[*]',
    columns: { n: { from: '$.n', type: ColumnType.Integer } },
    result: Array.from({ length: rows }, (_, n) => ({ n })),
  });
  return ingot;
}

async function notes(ingot: string) {
  const info = await world.info(ingot);
  const table = info.tables.find((candidate) => candidate.name === 'notes');
  if (!table) throw new Error('no notes table');
  return table;
}

async function scheduled(): Promise<number> {
  const { pool } = await openDatabase();
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM roll_up_due');
  return rows[0]?.n ?? 0;
}

const later = (ms: number) => new Date(Date.now() + ms);
const PAST_INTERVAL = INTERVAL_MS + 1_000;

describe('the roll-up schedule', () => {
  it('leaves a shallow overlay alone until the interval has passed', async () => {
    const ingot = await ingotWith(2);

    await sweeperAt(later(INTERVAL_MS / 2)).tick();
    expect(await notes(ingot)).toMatchObject({ pending: 2, generation: 0 });

    await sweeperAt(later(PAST_INTERVAL)).tick();
    expect(await notes(ingot)).toMatchObject({ pending: 0, generation: 1 });
    expect(await world.sql(ingot, 'SELECT count(*)::int AS n FROM notes')).toEqual([{ n: 2 }]);
  });

  it('rolls up at the row count without waiting for the interval', async () => {
    const ingot = await ingotWith(MIN_ROWS);

    await sweeperAt(new Date()).tick();

    expect(await notes(ingot)).toMatchObject({ pending: 0, generation: 1 });
  });

  it('unschedules a table once nothing is left in its overlay', async () => {
    await sweeperAt(later(PAST_INTERVAL)).tick();
    expect(await scheduled()).toBe(0);
  });

  it('starts the clock again for a table only deleted from', async () => {
    const ingot = await ingotWith(3);
    await sweeperAt(later(PAST_INTERVAL)).tick();
    expect(await world.forget(ingot, 'notes', 'n = 0')).toBe(1);

    await sweeperAt(new Date()).tick();
    expect((await notes(ingot)).generation).toBe(1);

    await sweeperAt(later(PAST_INTERVAL)).tick();
    expect((await notes(ingot)).generation).toBe(2);
    expect(await world.sql(ingot, 'SELECT count(*)::int AS n FROM notes')).toEqual([{ n: 2 }]);
  });

  it('works through more than one batch in a tick', async () => {
    const ingots = await Promise.all(Array.from({ length: 27 }, () => ingotWith(MIN_ROWS)));

    await sweeperAt(new Date()).tick();

    for (const ingot of ingots) expect((await notes(ingot)).pending).toBe(0);
    expect(await scheduled()).toBe(0);
  });

  it('schedules a table a racing write left unscheduled', async () => {
    const ingot = await ingotWith(2);
    const { pool } = await openDatabase();
    await pool.query('DELETE FROM roll_up_due');

    // A fresh sweeper housekeeps on its first tick, which is what finds it.
    await sweeperAt(new Date()).tick();
    expect(await scheduled()).toBe(1);

    await sweeperAt(later(PAST_INTERVAL)).tick();
    expect((await notes(ingot)).pending).toBe(0);
  });

  it('discards what a dropped table left in the overlay', async () => {
    const { pool } = await openDatabase();
    await pool.query(
      `INSERT INTO overlay_tombstone (table_id, row_id, at) VALUES ('tbl_gone', 'row_1', now())`,
    );
    // A minute back, since `now()` is the database's clock and the sweeper
    // compares against ours.
    await pool.query(
      `INSERT INTO roll_up_due (table_id, due_at) VALUES ('tbl_gone', now() - interval '1 minute')`,
    );

    await sweeperAt(new Date()).tick();

    const left = await pool.query(
      `SELECT 1 FROM overlay_tombstone WHERE table_id = 'tbl_gone'
       UNION ALL SELECT 1 FROM roll_up_due WHERE table_id = 'tbl_gone'`,
    );
    expect(left.rows).toHaveLength(0);
  });
});
