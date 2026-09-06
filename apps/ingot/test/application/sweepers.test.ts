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
 * The background work, and whether anything will actually run it.
 *
 * `SWEEPERS` being a `Record` over `SweptKind` is what makes a missing ticker a
 * compile error. This is the other half: that each entry is a real provider
 * with a schedule, resolvable out of the real `AppModule`, rather than a
 * decorated class in a module nobody imported.
 *
 * The failure it prevents is the quiet one. A sweeper that is never scheduled
 * looks exactly like one that has nothing to do — the service answers, rows go
 * in, queries come back — right up until the overlay is large enough that every
 * query is slow, and then it stays that way.
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
    // A schedule of zero would busy-loop; anything under a second is a typo
    // rather than an interval.
    expect(spec?.everyMs).toBeGreaterThan(1_000);
    expect(spec?.description?.length ?? 0).toBeGreaterThan(10);
  });

  /**
   * Every sweep takes a lock named for itself, so two of them sharing a key
   * would mean one silently never running while the other holds it. The names
   * are hand-written, and this is what stops two of them colliding — either as
   * names or, less visibly, as hashes of names.
   */
  it('gives each of them a lock of its own', () => {
    const names = Object.values(SWEEPERS).map((sweeper) => readCronSpec(sweeper)?.name ?? '');
    const keys = names.map(hash32);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * Resolvable from the real graph, and holding a `tick`.
   *
   * `SWEEPERS` is also the list `Scheduler` is given, so a class in it that the
   * container cannot build is a sweep that throws on its first turn — at which
   * point the only evidence is a log line on a running service.
   */
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

/**
 * What a tick is worth, which is not one drain.
 *
 * Each worker bounds a single drain with `PASSES` so that it yields rather than
 * holding a slot indefinitely. A sweeper that called `drain` once turned that
 * bound into a rate limit — a backlog moved at one drain per tick, however fast
 * the model answered and however many replicas were running, because nothing
 * else restarted a drain that stopped with work still queued.
 *
 * Pure: `drainWithin` takes a function and a number, so both properties are
 * asserted with no container, no database and no clock to wind forward.
 */
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

  /**
   * The bound that keeps a tick a tick. Without it a sweeper handed a large
   * enough backlog runs until it is gone — which is right for the work and
   * wrong for a shutdown waiting on the turn, and for the advisory lock one
   * replica would be holding throughout.
   */
  it('stops at the moment the next tick would have started', async () => {
    let calls = 0;

    // A deadline already in the past: the first drain runs, the second is the
    // one the deadline refuses. Checked between drains rather than inside one,
    // so a tick overruns by at most a single drain.
    const done = await drainWithin(0, async () => {
      calls += 1;
      return { done: 5, more: true };
    });

    expect(calls).toBe(1);
    expect(done).toBe(5);
  });
});
