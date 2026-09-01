import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { RestateServices } from '../../src/restate/index.js';
import { readCronSpec } from '../../src/restate/cron.decorator.js';
import { SweptKind } from '../../src/sweepers/kinds.js';
import { SWEEPERS } from '../../src/sweepers/sweepers.module.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * The background work, and whether Restate can actually reach it.
 *
 * `SWEEPERS` being a `Record` over `SweptKind` is what makes a missing ticker a
 * compile error. This is the other half: that each entry is a real Restate
 * service with a schedule, discovered from the real `AppModule`, rather than a
 * decorated class in a module nobody imported.
 *
 * The failure it prevents is the quiet one. A sweeper that is never registered
 * looks exactly like one that has nothing to do — the service answers, rows go
 * in, queries come back — right up until the overlay is large enough that every
 * query is slow, and then it stays that way.
 */
describe('the sweepers', () => {
  let app: TestingModule;

  beforeAll(async () => {
    const { pool } = await openDatabase();
    process.env.DATABASE_URL ??= (pool.options.connectionString as string) ?? '';
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('has a ticker for every kind of thing that can fall behind', () => {
    expect(Object.keys(SWEEPERS).sort()).toEqual(Object.values(SweptKind).sort());
  });

  it.each(Object.entries(SWEEPERS))('%s is a Restate cron with a schedule', (_kind, sweeper) => {
    const spec = readCronSpec(sweeper);

    expect(spec).toBeDefined();
    expect(spec?.name).toMatch(/^[a-z][a-z0-9-]*$/);
    // A schedule of zero would busy-loop the chain; anything under a second is
    // a typo rather than an interval.
    expect(spec?.everyMs).toBeGreaterThan(1_000);
    expect(spec?.description?.length ?? 0).toBeGreaterThan(10);
  });

  it('registers each of them with the real endpoint', () => {
    const services = app.get(RestateServices, { strict: false });
    // The endpoint's own view, not our bookkeeping: what Restate will be told
    // exists is the manifest built from these bindings.
    const discovered = services
      .discover()
      .map((service: { binding: { name: string } }) => service.binding.name);

    for (const sweeper of Object.values(SWEEPERS)) {
      const spec = readCronSpec(sweeper);
      expect({ sweeper: sweeper.name, discovered: discovered.includes(spec?.name ?? '') }).toEqual({
        sweeper: sweeper.name,
        discovered: true,
      });
    }
  });

  it('books the next tick as the last thing it does', async () => {
    // A tick that throws must never reach `scheduleNextTick`, so that the chain
    // is only extended by a pass that finished and a slow sweep cannot overlap
    // itself. Asserted on the source, because the alternative is a test that
    // has to make a sweeper fail halfway through a real Restate context.
    for (const sweeper of Object.values(SWEEPERS)) {
      const file = sweeper.name
        .replace(/Sweeper$/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();
      const source = await Bun.file(`src/sweepers/${file}.sweeper.ts`).text();

      const schedule = source.lastIndexOf('await scheduleNextTick');
      expect({ sweeper: sweeper.name, found: schedule > -1 }).toEqual({
        sweeper: sweeper.name,
        found: true,
      });

      /*
       * Nothing awaited after it *inside the handler it sits in*.
       *
       * Scoped to the method rather than to the rest of the file, because a
       * ticker may now have more than one handler: `/add` tells the embedding
       * and receipt services there is work instead of waiting for a tick, and
       * that is a second entry point which legitimately awaits. Slicing to
       * end-of-file used to be the same thing and quietly stopped being it.
       *
       * The method's closing brace is a `}` at two-space indent, which is what
       * Biome formats these to and is enough to bound the window.
       */
      const rest = source.slice(schedule);
      const closes = rest.indexOf('\n  }');
      const inHandler = closes === -1 ? rest : rest.slice(0, closes);
      expect(inHandler).not.toMatch(/await (?!scheduleNextTick)/);
    }
  });
});
