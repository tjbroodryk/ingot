import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { readCronSpec } from '../../src/sweepers/cron.js';
import { drainWithin } from '../../src/sweepers/drain-within.js';
import { hash32 } from '../../src/sweepers/exclusive.js';
import { SweptKind } from '../../src/sweepers/kinds.js';
import { Scheduler } from '../../src/sweepers/scheduler.js';
import { SWEEPERS } from '../../src/sweepers/sweepers.module.js';
import { compileAppModule } from '../support/app.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * Each `SWEEPERS` entry is a real provider with a schedule, resolvable out of
 * the real `AppModule`.
 */
describe('the sweepers', () => {
  let app: TestingModule;

  beforeAll(async () => {
    const { pool } = await openDatabase();
    process.env.DATABASE_URL ??= (pool.options.connectionString as string) ?? '';
    app = await compileAppModule().compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('has a ticker for every kind of thing that can fall behind', () => {
    expect(Object.keys(SWEEPERS).sort()).toEqual(Object.values(SweptKind).sort());
  });

  it.each(Object.entries(SWEEPERS))('%s has a schedule', (_kind, sweeper) => {
    const spec = readCronSpec(sweeper);

    expect(spec).toBeDefined();
    expect(spec?.name).toMatch(/^[a-z][a-z0-9-]*$/);
    // Under a second is a typo rather than an interval.
    expect(spec?.everyMs).toBeGreaterThan(1_000);
    expect(spec?.description?.length ?? 0).toBeGreaterThan(10);
  });

  // Each sweep locks on its own name, so names and their hashes must be unique.
  it('gives each of them a lock of its own', () => {
    const names = Object.values(SWEEPERS).map((sweeper) => readCronSpec(sweeper)?.name ?? '');
    const keys = names.map(hash32);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Resolvable from the real container and holding a `tick`.
  it('can build every one of them out of the real container', () => {
    for (const sweeper of Object.values(SWEEPERS)) {
      const instance = app.get(sweeper, { strict: false });
      expect({ sweeper: sweeper.name, tick: typeof instance.tick }).toEqual({
        sweeper: sweeper.name,
        tick: 'function',
      });
    }
  });

  it('is scheduled by the real graph', () => {
    expect(app.get(Scheduler, { strict: false })).toBeDefined();
  });
});

/** A tick drains repeatedly until the queue empties or the deadline passes. */
describe('a tick', () => {
  it('keeps going while the queue outlasts a drain', async () => {
    let calls = 0;

    const done = await drainWithin(60_000, async () => {
      calls += 1;
      // Three drains' worth of backlog, then the queue runs out.
      return { done: 10, more: calls < 3 };
    });

    expect(calls).toBe(3);
    expect(done).toBe(30);
  });

  it('stops at the first drain, when there was nothing more to do', async () => {
    let calls = 0;

    await drainWithin(60_000, async () => {
      calls += 1;
      return { done: 0, more: false };
    });

    expect(calls).toBe(1);
  });

  it('stops at the moment the next tick would have started', async () => {
    let calls = 0;

    // Deadline already past: the first drain runs, the second is refused. Checked
    // between drains, so a tick overruns by at most one drain.
    const done = await drainWithin(0, async () => {
      calls += 1;
      return { done: 5, more: true };
    });

    expect(calls).toBe(1);
    expect(done).toBe(5);
  });
});
