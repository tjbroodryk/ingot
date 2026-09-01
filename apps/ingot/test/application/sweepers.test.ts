import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { readCronSpec } from '../../src/sweepers/cron.js';
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
