import 'reflect-metadata';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../src/contexts/records/application/ports/overlay-store.port.js';
import {
  ROLL_UP_SETTINGS,
  type RollUpSettings,
} from '../../src/contexts/records/application/roll-up-settings.js';
import {
  type HeldClaim,
  TableRollUp,
} from '../../src/contexts/records/application/table-roll-up.js';
import { DATABASE_URL } from '../../src/database/database.module.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
  type CompactionRequest,
} from '../../src/engine/analytical-engine.port.js';
import { ParquetCache } from '../../src/engine/parquet-cache.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import type { Clock } from '../../src/shared/domain/index.js';
import { ExclusiveWork } from '../../src/sweepers/exclusive.js';
import { RollUpSweeper } from '../../src/sweepers/roll-up.sweeper.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Roll-up workers on several replicas, sharing `roll_up_due` through claims
 * rather than one advisory lock.
 */
let world: World;
let exclusive: ExclusiveWork;
let overlay: OverlayStore;
let rollUp: TableRollUp;
let engine: AnalyticalEngine;
let original: AnalyticalEngine['compact'];

const MIN_ROWS = 3;

beforeAll(async () => {
  world = await makeWorld({ env: { INGOT_ROLLUP_MIN_ROWS: String(MIN_ROWS) } });
  exclusive = new ExclusiveWork(world.app.get<string>(DATABASE_URL, { strict: false }));
  overlay = world.app.get<OverlayStore>(OVERLAY_STORE, { strict: false });
  rollUp = world.app.get(TableRollUp, { strict: false });
  engine = world.app.get<AnalyticalEngine>(ANALYTICAL_ENGINE, { strict: false });
  original = engine.compact.bind(engine);
});

afterEach(async () => {
  engine.compact = original;
  const { pool } = await openDatabase();
  await pool.query('DELETE FROM roll_up_due');
});

afterAll(async () => {
  await exclusive?.onApplicationShutdown();
  await world?.close();
  await closeDatabase();
});

function worker(instant = new Date()): RollUpSweeper {
  const clock: Clock = { now: () => instant };
  return new RollUpSweeper(
    world.app.get(Dispatcher),
    overlay,
    world.app.get(ParquetCache, { strict: false }),
    clock,
    world.app.get<RollUpSettings>(ROLL_UP_SETTINGS, { strict: false }),
    rollUp,
    exclusive,
  );
}

/** An ingot whose `notes` is due now, and that table's id. */
async function dueTable(): Promise<{ ingot: string; tableId: string }> {
  const ingot = await world.ingot();
  await world.add(ingot, {
    table: 'notes',
    rows: '$[*]',
    columns: { n: { from: '$.n', type: ColumnType.Integer } },
    result: Array.from({ length: MIN_ROWS }, (_, n) => ({ n })),
  });
  const { pool } = await openDatabase();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM ingot_table WHERE ingot_id = $1 AND name = 'notes'`,
    [ingot],
  );
  const tableId = rows[0]?.id;
  if (!tableId) throw new Error('no notes table');
  // Due a minute ago by the database's clock, whatever ours says.
  await pool.query(
    `UPDATE roll_up_due SET due_at = now() - interval '1 minute' WHERE table_id = $1`,
    [tableId],
  );
  return { ingot, tableId };
}

async function notes(ingot: string) {
  const table = (await world.info(ingot)).tables.find((candidate) => candidate.name === 'notes');
  if (!table) throw new Error('no notes table');
  return table;
}

/** A claim on one table, as a sweep would hold it. */
async function claimed(tableId: string): Promise<HeldClaim> {
  const token = crypto.randomUUID();
  const until = new Date(Date.now() + 300_000);
  const got = await overlay.claimRollUps(new Date(), 100, { token, until });
  expect(got).toContain(tableId);
  return {
    token,
    confirm: async () => {
      const renewed = await overlay.renewRollUpClaims([tableId], { token, until });
      if (!renewed.includes(tableId)) throw new Error('claim lost');
    },
  };
}

async function takeClaim(tableId: string): Promise<void> {
  const { pool } = await openDatabase();
  await pool.query(`UPDATE roll_up_due SET claim = 'someone-else' WHERE table_id = $1`, [tableId]);
}

describe('roll-up claims', () => {
  it('rolls each table up once when two workers sweep at the same time', async () => {
    const tables = await Promise.all(Array.from({ length: 30 }, () => dueTable()));

    await Promise.all([worker().tick(), worker().tick()]);

    for (const { ingot } of tables) {
      expect(await notes(ingot)).toMatchObject({ generation: 1, pending: 0 });
    }
  });

  it('leaves a table another worker holds until its lease lapses', async () => {
    const { ingot, tableId } = await dueTable();
    await claimed(tableId);

    await worker().tick();
    expect((await notes(ingot)).generation).toBe(0);

    await worker(new Date(Date.now() + 6 * 60_000)).tick();
    expect((await notes(ingot)).generation).toBe(1);
  });

  it('leaves what the new owner published untouched once its claim has been taken', async () => {
    const { ingot, tableId } = await dueTable();
    const claim = await claimed(tableId);
    let live = '';
    engine.compact = async (request: CompactionRequest) => {
      // As if the worker that took the table had already published its files
      // at these same keys.
      live = join(world.dataDir, request.baseTarget);
      mkdirSync(dirname(live), { recursive: true });
      writeFileSync(live, 'published by the new owner');
      await takeClaim(tableId);
      return original(request);
    };

    await expect(rollUp.run(tableId, claim)).rejects.toThrow(/claim lost/);

    expect(readFileSync(live, 'utf8')).toBe('published by the new owner');
    expect(readdirSync(dirname(live)).filter((name) => name.endsWith('.partial'))).toEqual([]);
    expect(await notes(ingot)).toMatchObject({ generation: 0, pending: MIN_ROWS });
  });

  it('publishes nothing once its claim has been taken, even with the files uploaded', async () => {
    const { ingot, tableId } = await dueTable();
    const claim = await claimed(tableId);
    engine.compact = async (request: CompactionRequest) => {
      const outcome = await original(request);
      await takeClaim(tableId);
      return outcome;
    };

    await expect(rollUp.run(tableId, claim)).rejects.toThrow(/lost its claim/);

    expect(await notes(ingot)).toMatchObject({ generation: 0, pending: MIN_ROWS });
  });
});
