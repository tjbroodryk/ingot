import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { CreateIngot } from '../../src/contexts/ingots/application/commands/create-ingot.command.js';
import { ListIngots } from '../../src/contexts/ingots/application/queries/list-ingots.query.js';
import { INGOT_REPOSITORY, type IngotRepository } from '../../src/contexts/ingots/domain/index.js';
import { ExpirySweeper } from '../../src/sweepers/expiry.sweeper.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import type { Clock } from '../../src/shared/domain/index.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Memories that delete themselves.
 *
 * This is the only thing in the service that destroys data nobody asked it to
 * destroy right now, so the assertions worth having are the ones about what it
 * leaves alone. A reaper that deletes everything passes any test that only
 * checks the expired thing is gone.
 */
let world: World;

beforeAll(async () => {
  world = await makeWorld();
});

afterAll(async () => {
  await world?.close();
  await closeDatabase();
});

/** The sweeper as the container would build it, but with time under control. */
function sweeperAt(instant: Date): ExpirySweeper {
  const clock: Clock = { now: () => instant };
  return new ExpirySweeper(
    world.app.get(Dispatcher),
    world.app.get<IngotRepository>(INGOT_REPOSITORY, { strict: false }),
    clock,
  );
}

const later = (ms: number) => new Date(Date.now() + ms);

describe('creating a memory with a retention', () => {
  it('reports when it will be deleted', async () => {
    const summary = await world.dispatcher.send(
      new CreateIngot(world.accountId, 'a fortnight', '14d'),
    );

    expect(summary.expiresAt).not.toBeNull();
    const due = new Date(summary.expiresAt as string).getTime();
    const expected = new Date(summary.createdAt).getTime() + 14 * 86_400_000;
    expect(Math.abs(due - expected)).toBeLessThan(1000);
  });

  it('keeps a memory indefinitely when no retention is given', async () => {
    const summary = await world.dispatcher.send(new CreateIngot(world.accountId, 'forever'));
    expect(summary.expiresAt).toBeNull();
  });

  it('reports it on /info too, so a caller can see what they asked for', async () => {
    const summary = await world.dispatcher.send(
      new CreateIngot(world.accountId, 'informative', '2h'),
    );
    const info = await world.info(summary.id);
    expect(info.expiresAt).toBe(summary.expiresAt);
  });

  it('refuses a retention it cannot read, before creating anything', async () => {
    const before = await world.dispatcher.ask(new ListIngots(world.accountId));

    await expect(
      world.dispatcher.send(new CreateIngot(world.accountId, 'bad', 'a fortnight')),
    ).rejects.toThrow(/not a retention/);

    const after = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(after.length).toBe(before.length);
  });
});

describe('the reaper', () => {
  it('deletes a memory past its retention, and everything in it', async () => {
    const doomed = await world.dispatcher.send(
      new CreateIngot(world.accountId, 'short-lived', '1m'),
    );
    await world.add(doomed.id, {
      table: 'notes',
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      result: { body: 'this will not survive' },
    });

    await sweeperAt(later(2 * 60_000)).tick();

    const remaining = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(remaining.map((ingot) => ingot.id)).not.toContain(doomed.id);

    // The rows went with it, rather than being orphaned under a manifest that
    // no longer exists.
    await expect(world.info(doomed.id)).rejects.toThrow();
  });

  it('leaves a memory that has not expired', async () => {
    const keeping = await world.dispatcher.send(new CreateIngot(world.accountId, 'patient', '4w'));

    await sweeperAt(later(60_000)).tick();

    const remaining = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(remaining.map((ingot) => ingot.id)).toContain(keeping.id);
  });

  it('never touches a memory with no retention at all', async () => {
    const forever = await world.dispatcher.send(new CreateIngot(world.accountId, 'permanent'));

    // A decade on, and it is still there. `expires_at IS NULL` is not a date
    // in the past, and a reaper that treated it as one would delete every
    // memory in the service on its first tick.
    await sweeperAt(later(3650 * 86_400_000)).tick();

    const remaining = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(remaining.map((ingot) => ingot.id)).toContain(forever.id);
  });

  /*
   * The two tests that used to sit here asserted that a tick booked the next
   * one — of itself, as its last act, whether or not it reaped anything. There
   * is no chain to extend any more: `Scheduler` books the next turn and does it
   * in both its success and its failure paths, which is where that property now
   * lives and where `scheduler.test.ts` holds it.
   */

  /**
   * The re-read before the delete.
   *
   * The listing already filtered on `expires_at <= now` in SQL, so a row that
   * comes back and then says it has not expired should be impossible. It is
   * checked anyway, because the cost is one indexed read at a cap of
   * twenty-five and the thing it guards is irreversible.
   */
  it('refuses to delete something that turns out not to be expired', async () => {
    const survivor = await world.dispatcher.send(
      new CreateIngot(world.accountId, 'mislisted', '4w'),
    );
    const real = world.app.get<IngotRepository>(INGOT_REPOSITORY, { strict: false });

    // A repository that lies about what is due — which is what a clock skew or
    // a future "extend the retention" endpoint would look like from here.
    const lying: IngotRepository = {
      ...real,
      findById: (id) => real.findById(id),
      listExpired: async () => [{ id: survivor.id, accountId: world.accountId, name: 'mislisted' }],
    };

    const sweeper = new ExpirySweeper(world.app.get(Dispatcher), lying, {
      now: () => new Date(),
    });
    await sweeper.tick();

    const remaining = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(remaining.map((ingot) => ingot.id)).toContain(survivor.id);
  });
});
