import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import {
  BackgroundKind,
  BackgroundWork,
} from '../../src/contexts/records/application/background.js';
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
 * The coalescing, which is what replaced an idempotency key.
 *
 * Restate collapsed duplicate sends on a key it held for a retention window.
 * In-process the equivalent is here, and it is worth testing directly because
 * the property it protects is not correctness — concurrent drains are safe,
 * the claim leases its rows — but spend: a burst of writes must not become a
 * burst of concurrent calls at whatever model `INGOT_EMBEDDER` names.
 *
 * No database and no container: `BackgroundWork` orchestrates two workers and
 * nothing else, so the workers are stand-ins and the test is about the
 * orchestration.
 */
describe('waking the background', () => {
  /** A worker whose drain finishes when the test says so. */
  function pausable() {
    let release: (() => void) | undefined;
    let started = 0;

    return {
      started: () => started,
      release: () => release?.(),
      worker: {
        async drain() {
          started++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return 0;
        },
      },
    };
  }

  function workFrom(embed: { drain(): Promise<number> }): BackgroundWork {
    const idle = {
      async drain() {
        return 0;
      },
    };
    return new BackgroundWork(
      embed as unknown as EmbedWorker,
      idle as unknown as ReceiptWorker,
      idle as unknown as DeliveryWorker,
    );
  }

  it('does not start a second drain while one is running', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    background.wakeEmbeddings();
    background.wakeEmbeddings();

    expect(embed.started()).toBe(1);

    embed.release();
    await background.settled();
  });

  /**
   * A row queued just after a drain read the queue and just before it finished
   * would otherwise wait for the sweeper. One more pass costs an empty query
   * when there is nothing there.
   */
  it('runs one more pass for the wakes that arrived while it was busy', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    background.wakeEmbeddings();

    embed.release();
    await background.settled();
    // The trailing run is booked from the first one's `finally`, so it starts
    // after `settled` resolved on the first promise.
    await Promise.resolve();
    embed.release();
    await background.settled();

    expect(embed.started()).toBe(2);
  });

  /**
   * Nothing is waiting on a wake: the caller's rows are committed and their
   * response is gone. A throw here would be an unhandled rejection in a
   * detached promise — a way to take the process down over work the sweeper
   * already covers.
   */
  it('swallows a drain that throws', async () => {
    const background = workFrom({
      async drain(): Promise<number> {
        throw new Error('the embedder is down');
      },
    });

    background.wakeEmbeddings();
    await background.settled();
  });
});
