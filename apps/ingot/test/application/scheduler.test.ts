import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { ModuleRef } from '@nestjs/core';
import { Cron } from '../../src/sweepers/cron.js';
import type { ExclusiveWork } from '../../src/sweepers/exclusive.js';
import { Scheduler, type Ticker } from '../../src/sweepers/scheduler.js';

/**
 * What runs the sweepers, now that nothing durable does.
 *
 * Three properties moved out of the sweepers and into this class when the
 * Restate cron chain went, and each used to be asserted somewhere else:
 *
 * - **The schedule survives a quiet tick.** `expiry.test.ts` used to check that
 *   a pass which reaped nothing still booked the next one, because a chain that
 *   is only extended by a pass that did something stops the first time nothing
 *   is due.
 * - **The schedule survives a failing tick.** Restate retried an invocation
 *   that threw; here the loop has to book the next turn from its own catch, or
 *   one bad sweep ends that sweeper for the life of the process.
 * - **One replica at a time.** The lock is what stops two pods rolling the same
 *   table up into the same generation, and a scheduler that ticked anyway when
 *   it could not take the lock would quietly undo it.
 *
 * No database and no container: the lock and the module are stand-ins, because
 * what is under test is the loop.
 */

/** A `ModuleRef` that answers with instances it was handed. */
function containerOf(instances: Map<unknown, Ticker>): ModuleRef {
  return {
    get: (token: unknown) => instances.get(token),
  } as unknown as ModuleRef;
}

/** A lock that is always free, or never. */
function lock(free: boolean, attempts: string[] = []): ExclusiveWork {
  return {
    async attempt(key: string, work: () => Promise<void>) {
      attempts.push(key);
      if (!free) return false;
      await work();
      return true;
    },
  } as unknown as ExclusiveWork;
}

/** Lets the event loop run the timers the scheduler booked. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the scheduler', () => {
  it('keeps ticking after a pass that did nothing', async () => {
    let ticks = 0;

    @Cron({ name: 'quiet', everyMs: 5, description: 'a sweep with nothing to do' })
    class Quiet implements Ticker {
      async tick(): Promise<void> {
        ticks++;
      }
    }

    const instance = new Quiet();
    const scheduler = new Scheduler([Quiet], containerOf(new Map([[Quiet, instance]])), lock(true));

    scheduler.onApplicationBootstrap();
    await settle();
    await scheduler.onModuleDestroy();

    expect(ticks).toBeGreaterThan(1);
  });

  it('keeps ticking after a pass that threw', async () => {
    let ticks = 0;

    @Cron({ name: 'broken', everyMs: 5, description: 'a sweep that always fails' })
    class Broken implements Ticker {
      async tick(): Promise<void> {
        ticks++;
        throw new Error('the bucket is away');
      }
    }

    const instance = new Broken();
    const scheduler = new Scheduler(
      [Broken],
      containerOf(new Map([[Broken, instance]])),
      lock(true),
    );

    scheduler.onApplicationBootstrap();
    // The first retry is `FIRST_BACKOFF_MS` out, so only the boot tick has run
    // by now — the property under test is that the loop is still alive, not how
    // fast it comes back.
    await settle();
    await scheduler.onModuleDestroy();

    expect(ticks).toBe(1);
  });

  it('does not tick when another replica holds the lock', async () => {
    let ticks = 0;
    const attempts: string[] = [];

    @Cron({ name: 'contended', everyMs: 5, description: 'a sweep somebody else is doing' })
    class Contended implements Ticker {
      async tick(): Promise<void> {
        ticks++;
      }
    }

    const scheduler = new Scheduler(
      [Contended],
      containerOf(new Map([[Contended, new Contended()]])),
      lock(false, attempts),
    );

    scheduler.onApplicationBootstrap();
    await settle();
    await scheduler.onModuleDestroy();

    // It kept trying — losing the lock is not a reason to back off, because the
    // work is being done and the next turn comes round as usual.
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.every((key) => key === 'contended')).toBe(true);
    expect(ticks).toBe(0);
  });

  it('stops when the application does', async () => {
    let ticks = 0;

    @Cron({ name: 'stoppable', everyMs: 5, description: 'a sweep that should stop' })
    class Stoppable implements Ticker {
      async tick(): Promise<void> {
        ticks++;
      }
    }

    const scheduler = new Scheduler(
      [Stoppable],
      containerOf(new Map([[Stoppable, new Stoppable()]])),
      lock(true),
    );

    scheduler.onApplicationBootstrap();
    await settle();
    await scheduler.onModuleDestroy();

    const after = ticks;
    await settle();
    // A pod that has been told to go away does not keep sweeping. Left running,
    // it would hold the advisory lock a replica taking over is waiting for.
    expect(ticks).toBe(after);
  });
});
