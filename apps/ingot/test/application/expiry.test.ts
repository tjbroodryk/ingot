import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { CreateAccount } from '../../src/contexts/accounts/application/commands/create-account.command.js';
import { CastIngot } from '../../src/contexts/ingots/application/commands/cast-ingot.command.js';
import { ListIngots } from '../../src/contexts/ingots/application/queries/list-ingots.query.js';
import { INGOT_REPOSITORY, type IngotRepository } from '../../src/contexts/ingots/domain/index.js';
import { ExpirySweeper } from '../../src/sweepers/expiry.sweeper.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import type { Clock } from '../../src/shared/domain/index.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Ingots that delete themselves.
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

const create = (name: string, retainFor?: string) =>
  world.dispatcher
    .send(new CastIngot(world.accountId, name, retainFor))
    .then((created) => created.ingot);

describe('casting an ingot with a retention', () => {
  it('reports when it will be deleted', async () => {
    const summary = await create('a fortnight', '14d');

    expect(summary.expiresAt).not.toBeNull();
    const due = new Date(summary.expiresAt as string).getTime();
    const expected = new Date(summary.createdAt).getTime() + 14 * 86_400_000;
    expect(Math.abs(due - expected)).toBeLessThan(1000);
  });

  it('keeps an ingot indefinitely when no retention is given', async () => {
    const summary = await create('forever');
    expect(summary.expiresAt).toBeNull();
  });

  it('reports it on /info too, so a caller can see what they asked for', async () => {
    const summary = await create('informative', '2h');
    const info = await world.info(summary.id);
    expect(info.expiresAt).toBe(summary.expiresAt);
  });

  it('refuses a retention it cannot read, before creating anything', async () => {
    const before = await world.dispatcher.ask(new ListIngots(world.accountId));

    await expect(create('bad', 'a fortnight')).rejects.toThrow(/not a retention/);

    const after = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(after.length).toBe(before.length);
  });
});

describe('the reaper', () => {
  it('deletes an ingot past its retention, and everything in it', async () => {
    const doomed = await create('short-lived', '1m');
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

  it('leaves an ingot that has not expired', async () => {
    const keeping = await create('patient', '4w');

    await sweeperAt(later(60_000)).tick();

    const remaining = await world.dispatcher.ask(new ListIngots(world.accountId));
    expect(remaining.map((ingot) => ingot.id)).toContain(keeping.id);
  });

  it('never touches an ingot with no retention at all', async () => {
    const forever = await create('permanent');

    // A decade on, and it is still there. `expires_at IS NULL` is not a date
    // in the past, and a reaper that treated it as one would delete every
    // ingot in the service on its first tick.
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
    const survivor = await create('mislisted', '4w');
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

describe('extending a retention', () => {
  it('restarts the clock from the call, not from creation', async () => {
    const summary = await create('still in use', '1h');

    const config = await world.configureIngot(summary.id, { retainFor: '14d' });

    const due = new Date(config.expiresAt as string).getTime();
    expect(Math.abs(due - (Date.now() + 14 * 86_400_000))).toBeLessThan(5000);
    expect((await world.info(summary.id)).expiresAt).toBe(config.expiresAt);
  });

  it('keeps an ingot indefinitely when given null', async () => {
    const summary = await create('reprieved', '1h');

    expect((await world.configureIngot(summary.id, { retainFor: null })).expiresAt).toBeNull();
  });

  it('leaves the retention alone when the patch does not mention it', async () => {
    const summary = await create('untouched', '2h');

    expect((await world.configureIngot(summary.id, {})).expiresAt).toBe(summary.expiresAt);
  });

  it('refuses a retention it cannot read, and changes nothing', async () => {
    const summary = await create('misconfigured', '2h');

    await expect(world.configureIngot(summary.id, { retainFor: 'soon' })).rejects.toThrow(
      /not a retention/,
    );
    expect((await world.info(summary.id)).expiresAt).toBe(summary.expiresAt);
  });
});

describe('casting an ingot under a handle of your own', () => {
  const withHandle = (name: string, externalId: string, retainFor?: string) =>
    world.dispatcher.send(new CastIngot(world.accountId, name, retainFor, externalId));

  it('answers a second create with the ingot the first one made', async () => {
    const first = await withHandle('conversation ingot', 'chat_1');
    const second = await withHandle('a different name', 'chat_1', '1h');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ingot.id).toBe(first.ingot.id);
    // Nothing about the existing ingot moved because somebody asked again.
    expect(second.ingot.name).toBe('conversation ingot');
    expect(second.ingot.expiresAt).toBeNull();
    expect(second.ingot.externalId).toBe('chat_1');
  });

  it('makes one ingot for concurrent creates with the same handle', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => withHandle('raced', 'chat_race')),
    );

    expect(new Set(results.map((result) => result.ingot.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('keeps handles per account', async () => {
    const other = await world.dispatcher.send(new CreateAccount('another-account', 'Another'));

    const here = await withHandle('mine', 'chat_shared');
    const there = await world.dispatcher.send(
      new CastIngot(other.account.id, 'theirs', undefined, 'chat_shared'),
    );

    expect(there.created).toBe(true);
    expect(there.ingot.id).not.toBe(here.ingot.id);
  });

  it('makes a new ingot when the one holding the handle has expired', async () => {
    const stale = await withHandle('past its time', 'chat_stale', '1h');
    const { pool } = await openDatabase();
    await pool.query(`UPDATE ingot SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      stale.ingot.id,
    ]);

    const fresh = await withHandle('picked up again', 'chat_stale');

    expect(fresh.created).toBe(true);
    expect(fresh.ingot.id).not.toBe(stale.ingot.id);
    // The old one still goes to the reaper, but no longer answers to the handle.
    expect((await world.info(stale.ingot.id)).externalId).toBeNull();
  });
});
