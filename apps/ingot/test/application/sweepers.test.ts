import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { readCronSpec } from '../../src/sweepers/cron.js';
import { drainWithin } from '../../src/sweepers/drain-within.js';
import { ExclusiveWork, hash32 } from '../../src/sweepers/exclusive.js';
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
  let pool: Awaited<ReturnType<typeof openDatabase>>['pool'];
  let url: string;

  beforeAll(async () => {
    ({ pool } = await openDatabase());
    url = (pool.options.connectionString as string) ?? '';
    process.env.DATABASE_URL ??= url;
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
   * Which sweeps take a lock at all, pinned.
   *
   * `exclusive` defaults to true, so the risk this guards is not a sweep that
   * forgets to ask for the lock — it is one that sets `false` because a backlog
   * looked slow, on work that is not in fact safe on two pods at once. Roll-up
   * is the reason the lock exists: two replicas compacting one table both
   * compute `generation + 1` and both flip the manifest. Expiry keeps it for a
   * different reason, which is that `PER_TICK` bounds a deletion and per
   * replica it would stop bounding anything.
   */
  it('takes a lock for exactly the sweeps that need one', () => {
    const exclusive = Object.values(SWEEPERS)
      .map((sweeper) => readCronSpec(sweeper))
      .filter((spec) => spec?.exclusive ?? true)
      .map((spec) => spec?.name)
      .sort();

    expect(exclusive).toEqual(['reap-expired-ingots', 'roll-up-ingots']);
  });

  /**
   * One connection, however many sweeps tick at the same moment.
   *
   * Every sweeper's first turn is booked at a delay of zero, so all six ask
   * `ExclusiveWork` for its connection in the same timer phase — before any of
   * them has one. Against a plain `client | null` field they each read `null`,
   * each open a socket, and the last to finish wins the field: six backends
   * where the pool is sized at ten, five of them reachable by nothing, so never
   * ended and still holding the event loop open through a shutdown.
   *
   * `pg_stat_activity` is the check rather than anything internal, because what
   * is being guarded is a real backend on a real server. A delta rather than a
   * count, because the app this suite booted is running its own scheduler and
   * holds a lock connection of its own.
   */
  it('opens one lock connection however many sweeps tick together', async () => {
    const sessions = async (): Promise<number> => {
      const { rows } = await pool.query<{ open: number }>(
        `SELECT count(*)::int AS open FROM pg_stat_activity
          WHERE application_name = 'ingot-sweepers' AND datname = current_database()`,
      );
      return rows[0]?.open ?? 0;
    };

    const before = await sessions();
    const exclusive = new ExclusiveWork(url);
    const names = Object.values(SWEEPERS).map((sweeper) => readCronSpec(sweeper)?.name ?? '');

    try {
      await Promise.all(names.map((name) => exclusive.attempt(name, async () => undefined)));

      expect(await sessions()).toBe(before + 1);
    } finally {
      await exclusive.onApplicationShutdown();
    }
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
   * wrong for a shutdown waiting on the turn inside a grace period that does
   * not last.
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
