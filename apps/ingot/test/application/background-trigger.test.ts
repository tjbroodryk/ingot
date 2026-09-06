import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import {
  BackgroundKind,
  BackgroundWork,
} from '../../src/contexts/records/application/background.js';
import type { Drained } from '../../src/contexts/records/application/drained.js';
import type { EmbedWorker } from '../../src/contexts/records/application/embed-worker.js';
import type { DeliveryWorker } from '../../src/contexts/records/application/delivery-worker.js';
import type { ReceiptWorker } from '../../src/contexts/records/application/receipt-worker.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * What `/add` tells the background, and whether it tells it at all.
 *
 * The failure it guards against is quiet in the way this service's failures
 * usually are. A wake that stops happening costs nothing visible: the rows
 * commit, `/add` answers, the receipt hands back a query that works. The only
 * symptom is that a row is findable by meaning a minute later instead of
 * immediately — a latency regression with no error, no log line, and nothing
 * that fails until somebody times it.
 *
 * The wake is bound out in the harness rather than by an environment variable,
 * so the production path has no branch in it and this file can watch it work.
 */
describe('what a write sets off', () => {
  let world: World;
  let ingot: string;

  const embedded = {
    table: 'notes',
    columns: {
      body: { from: '$.body', type: ColumnType.Varchar, embed: true },
    },
  };

  const plain = {
    table: 'plain_notes',
    columns: {
      body: { from: '$.body', type: ColumnType.Varchar },
    },
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory with a background');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('wakes the embedding worker the moment a write queues work', async () => {
    const before = world.wakes.length;

    const added = await world.add(ingot, {
      ...embedded,
      result: { body: 'the migration broke on a missing index' },
    });

    expect(added.queuedForEmbedding).toBeGreaterThan(0);
    expect(world.wakes.slice(before)).toEqual([BackgroundKind.Embeddings]);
  });

  it('says nothing when a write queued nothing', async () => {
    const before = world.wakes.length;

    const added = await world.add(ingot, {
      ...plain,
      result: { body: 'nothing here is embedded' },
    });

    expect(added.queuedForEmbedding).toBe(0);
    expect(world.wakes.slice(before)).toEqual([]);
  });

  it('wakes the receipt worker only when a receipt was asked for', async () => {
    const before = world.wakes.length;

    await world.add(ingot, {
      ...plain,
      receipt: ReceiptKind.Schema,
      result: { body: 'a schema receipt is built inline' },
    });
    expect(world.wakes.slice(before)).toEqual([]);

    await world.add(ingot, {
      ...plain,
      receipt: ReceiptKind.Full,
      result: { body: 'a full receipt is written in the background' },
    });

    expect(world.wakes.slice(before)).toEqual([BackgroundKind.Receipts]);
  });

  it('wakes after the commit, not inside it', async () => {
    const before = world.wakes.length;

    await world.add(ingot, {
      ...embedded,
      result: { body: 'a note whose rows must exist by the time anyone is told' },
    });

    // The rows the wake is about are readable from outside the transaction by
    // the time it goes. Waking from inside would announce work a rollback could
    // still take away, and the worker would go looking for a queue row that
    // never existed.
    expect(world.wakes.length).toBe(before + 1);
    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});

/**
 * The bound, which is what replaced an idempotency key.
 *
 * Restate collapsed duplicate sends on a key it held for a retention window.
 * In-process the equivalent is here, and it is worth testing directly because
 * the property it protects is not correctness — concurrent drains are safe,
 * the claim leases its rows — but spend: a burst of writes must not become an
 * unbounded burst of concurrent calls at whatever model `INGOT_EMBEDDER` names.
 *
 * It is a *bound* rather than a lock, and the difference is latency. Serialised,
 * a write arriving at the start of a busy drain waits behind every model call
 * that drain still has to make before its own batch is claimed. So the tests
 * below hold both halves: that a second drain may start while the first is
 * mid-call, and that one past the bound may not.
 *
 * No database and no container: `BackgroundWork` orchestrates three workers and
 * nothing else, so the workers are stand-ins and the test is about the
 * orchestration.
 */
describe('waking the background', () => {
  /**
   * A worker whose drains finish when the test says so.
   *
   * Every drain in flight is held, and `release` lets all of them go — with a
   * bound above one there can be several, and releasing only the newest would
   * leave the earlier ones pending and hang `settled`.
   */
  function pausable(more = false) {
    const holding: (() => void)[] = [];
    let started = 0;

    return {
      started: () => started,
      release: () => {
        for (const resolve of holding.splice(0)) resolve();
      },
      worker: {
        async drain(): Promise<Drained> {
          started++;
          await new Promise<void>((resolve) => {
            holding.push(resolve);
          });
          return { done: 0, more };
        },
      },
    };
  }

  /** The bound this file asserts against, rather than whatever ships today. */
  const LIMITS: Record<BackgroundKind, number> = {
    [BackgroundKind.Embeddings]: 2,
    [BackgroundKind.Receipts]: 1,
    [BackgroundKind.Deliveries]: 1,
  };

  function workFrom(embed: { drain(): Promise<Drained> }): BackgroundWork {
    const idle = {
      async drain(): Promise<Drained> {
        return { done: 0, more: false };
      },
    };
    return new BackgroundWork(
      embed as unknown as EmbedWorker,
      idle as unknown as ReceiptWorker,
      idle as unknown as DeliveryWorker,
      // Pinned, so this describes the mechanism rather than today's numbers.
      // A test that read `CONCURRENCY` would pass whatever it was changed to,
      // which is a test that asserts nothing.
      LIMITS,
    );
  }

  it('runs drains up to the bound, and no more', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    background.wakeEmbeddings();
    background.wakeEmbeddings();
    background.wakeEmbeddings();

    // Two slots taken, the other two wakes collapsed onto the trailing re-run.
    expect(embed.started()).toBe(LIMITS[BackgroundKind.Embeddings]);

    embed.release();
    await background.settled();
  });

  /**
   * The half that is about latency rather than spend.
   *
   * A second write arriving while the first drain is mid-model-call gets its
   * own drain rather than waiting for that call to come back. Serialised, this
   * is where the seconds came from.
   */
  it('lets a second write start its own drain rather than queueing behind one', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    expect(embed.started()).toBe(1);

    // Nothing released: the first drain is still inside its model call.
    background.wakeEmbeddings();
    expect(embed.started()).toBe(2);

    embed.release();
    await background.settled();
  });

  /**
   * A row queued just after a drain read the queue and just before it finished
   * would otherwise wait for the sweeper. One more pass costs an empty query
   * when there is nothing there.
   */
  it('runs one more pass for the wakes that arrived with every slot taken', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    // One past the bound, so the third is the one with nowhere to go.
    background.wakeEmbeddings();
    background.wakeEmbeddings();
    background.wakeEmbeddings();
    expect(embed.started()).toBe(2);

    embed.release();
    await background.settled();
    // The trailing run is booked from a `finally`, so it starts after
    // `settled` resolved on the promises that were in flight.
    await Promise.resolve();
    embed.release();
    await background.settled();

    expect(embed.started()).toBe(3);
  });

  /**
   * The other half of the throughput fix, and the one a sweeper cannot supply.
   *
   * A drain that stops on its own bound with the queue still full used to wait
   * out a minute for the next tick — so `PASSES` was a rate limit rather than a
   * yield point, and a single `/add` fanning out into thousands of rows got one
   * drain and then nothing. `Drained.more` is the worker saying so, and the
   * trailing re-run is what acts on it.
   */
  it('books another drain when one stops with the queue still full', async () => {
    const embed = pausable(true);
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    expect(embed.started()).toBe(1);

    embed.release();
    await background.settled();
    // Booked from the first drain's `then`, so it starts once that promise has
    // settled — no wake arrived, and one is owed anyway.
    await Promise.resolve();
    expect(embed.started()).toBeGreaterThan(1);

    embed.release();
    await background.settled();
  });

  /**
   * Nothing is waiting on a wake: the caller's rows are committed and their
   * response is gone. A throw here would be an unhandled rejection in a
   * detached promise — a way to take the process down over work the sweeper
   * already covers.
   *
   * It must also not chain: a drain that threw is a model that is down, and
   * re-running immediately is a tight loop against it. `more` is read from the
   * result, which a throw never produces.
   */
  it('swallows a drain that throws', async () => {
    const background = workFrom({
      async drain(): Promise<Drained> {
        throw new Error('the embedder is down');
      },
    });

    background.wakeEmbeddings();
    await background.settled();
  });
});
