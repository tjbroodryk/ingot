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
import type { FileWorker } from '../../src/contexts/files/application/file-worker.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/** What `/add` tells the background, and whether it tells it at all. */
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

    // Rows are readable from outside the transaction by the time the wake goes.
    expect(world.wakes.length).toBe(before + 1);
    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});

/** Bounds concurrent drains: a burst of wakes must not fan out unboundedly. */
describe('waking the background', () => {
  // A worker whose drains finish when the test calls `release`. Holds every
  // drain in flight, since the bound can exceed one.
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

  const LIMITS: Record<BackgroundKind, number> = {
    [BackgroundKind.Embeddings]: 2,
    [BackgroundKind.Receipts]: 1,
    [BackgroundKind.Deliveries]: 1,
    [BackgroundKind.Files]: 1,
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
      idle as unknown as FileWorker,
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

    // Two slots taken; the other two wakes collapse onto the trailing re-run.
    expect(embed.started()).toBe(LIMITS[BackgroundKind.Embeddings]);

    embed.release();
    await background.settled();
  });

  it('lets a second write start its own drain rather than queueing behind one', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    expect(embed.started()).toBe(1);

    // Nothing released: the first drain is still in flight.
    background.wakeEmbeddings();
    expect(embed.started()).toBe(2);

    embed.release();
    await background.settled();
  });

  it('runs one more pass for the wakes that arrived with every slot taken', async () => {
    const embed = pausable();
    const background = workFrom(embed.worker);

    // One past the bound: the third wake has nowhere to go.
    background.wakeEmbeddings();
    background.wakeEmbeddings();
    background.wakeEmbeddings();
    expect(embed.started()).toBe(2);

    embed.release();
    await background.settled();
    // The trailing run is booked from a `finally`, so it starts after `settled`
    // resolved on the in-flight promises.
    await Promise.resolve();
    embed.release();
    await background.settled();

    expect(embed.started()).toBe(3);
  });

  // `Drained.more` is the worker reporting the queue is still full; the
  // trailing re-run acts on it.
  it('books another drain when one stops with the queue still full', async () => {
    const embed = pausable(true);
    const background = workFrom(embed.worker);

    background.wakeEmbeddings();
    expect(embed.started()).toBe(1);

    embed.release();
    await background.settled();
    // Booked from the first drain's `then`, so it starts once that promise
    // settles — no wake arrived, and one is owed anyway.
    await Promise.resolve();
    expect(embed.started()).toBeGreaterThan(1);

    embed.release();
    await background.settled();
  });

  // A throw must not become an unhandled rejection, nor chain into a re-run
  // (`more` is read from the result, which a throw never produces).
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
