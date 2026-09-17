import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { GetBaseFile } from '../../src/contexts/records/application/queries/get-base-file.query.js';
import { GetPendingOperations } from '../../src/contexts/records/application/queries/get-pending-operations.query.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../src/contexts/records/application/ports/overlay-store.port.js';
import { DropTable } from '../../src/contexts/ingots/application/commands/drop-table.command.js';
import { ReapGenerations } from '../../src/contexts/records/application/commands/reap-generations.command.js';
import {
  AggregateNotFound,
  InvariantViolation,
  ResourceGone,
} from '../../src/shared/domain/index.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The two tiers, handed over separately.
 *
 * `/pending` and `/parquet` together are the whole table, and the tests below
 * walk one table through a roll-up and a delete to hold that up: rows move from
 * one to the other, and a forgotten row stays in the file until the next
 * roll-up while the tombstone saying so is reported beside it.
 */
describe('pending writes and the Parquet beneath them', () => {
  let world: World;
  let ingot: string;

  const events = (from: number, count: number) => ({
    table: 'events',
    rows: '$.items[*]',
    columns: { n: { from: '$.n', type: ColumnType.Integer } },
    result: { items: Array.from({ length: count }, (_, at) => ({ n: from + at })) },
  });

  const pending = (page: { after?: string; limit?: number } = {}) =>
    world.dispatcher.ask(new GetPendingOperations(ingot, world.accountId, 'events', page));

  const parquet = (at: { generation?: number; part?: number } = {}) =>
    world.dispatcher.ask(new GetBaseFile(ingot, world.accountId, 'events', at));

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an ingot with an overlay');
    await world.add(ingot, events(0, 3));
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('lists overlay rows oldest first, as stored', async () => {
    const found = await pending();

    expect(found.generation).toBe(0);
    expect(found.rows.map((row) => row.values.n)).toEqual([0, 1, 2]);
    expect(found.tombstones).toEqual([]);
    expect(found.next).toBeNull();
  });

  it('pages by sequence, and says when there is no more', async () => {
    const first = await pending({ limit: 2 });
    expect(first.rows.map((row) => row.values.n)).toEqual([0, 1]);
    expect(first.next).not.toBeNull();

    // Exactly `limit` rows left is the case a naive "fewer than limit" check gets wrong.
    const second = await pending({ after: first.next ?? undefined, limit: 1 });
    expect(second.rows.map((row) => row.values.n)).toEqual([2]);
    expect(second.next).toBeNull();
  });

  it('refuses a cursor that is not a sequence', async () => {
    await expect(pending({ after: '1 OR 1=1' })).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('does not reach a table in somebody else’s account', async () => {
    await expect(
      world.dispatcher.ask(new GetPendingOperations(ingot, 'acct_somebody_else', 'events')),
    ).rejects.toBeInstanceOf(AggregateNotFound);
  });

  it('has no Parquet before the first roll-up', async () => {
    await expect(parquet()).rejects.toBeInstanceOf(AggregateNotFound);
  });

  it('empties the overlay into a file that can be downloaded whole', async () => {
    await world.compact(ingot, 'events');

    const after = await pending();
    expect(after.rows).toEqual([]);
    expect(after.generation).toBe(1);

    const file = await parquet();
    const bytes = await drain(await file.open());
    expect(file.generation).toBe(1);
    expect(file.rows).toBe(3);
    expect(bytes.length).toBe(file.bytes);
    // Parquet opens and closes with its magic number.
    expect(bytes.subarray(0, 4).toString()).toBe('PAR1');
    expect(bytes.subarray(-4).toString()).toBe('PAR1');
  });

  it('reports a row forgotten since the roll-up, which the file still holds', async () => {
    expect(await world.forget(ingot, 'events', 'n = 1')).toBe(1);

    const found = await pending();
    expect(found.rows).toEqual([]);
    expect(found.tombstones.length).toBe(1);

    const file = await parquet();
    expect(file.rows).toBe(3);
    expect(file.tombstones).toBe(1);
  });

  it('lists the files of the generation it is pending against', async () => {
    const found = await pending();

    expect(found.base).toEqual([{ part: 1, rows: 3, bytes: expect.any(Number) }]);
    expect(found.base[0]?.bytes).toBeGreaterThan(0);
  });

  it('reads the manifest and the overlay as of one moment, whenever a roll-up lands', async () => {
    await world.add(ingot, events(10, 2));

    // The roll-up is made to commit after the manifest is read and before the
    // overlay is — on its own connection, outside the read's transaction.
    const overlay = world.app.get<OverlayStore>(OVERLAY_STORE, { strict: false });
    const page = overlay.page.bind(overlay);
    const outside = AsyncLocalStorage.snapshot();
    let rolledUp = false;
    overlay.page = async (...args) => {
      if (!rolledUp) {
        rolledUp = true;
        await outside(() => world.compact(ingot, 'events'));
      }
      return page(...args);
    };

    try {
      const found = await pending();
      expect(found.generation).toBe(1);
      expect(found.rows.map((row) => row.values.n)).toEqual([10, 11]);

      const after = await pending();
      expect(after.generation).toBe(2);
      expect(after.rows).toEqual([]);
    } finally {
      overlay.page = page;
    }
  });

  it('keeps the generation it replaced readable, by number', async () => {
    const current = await parquet();
    const replaced = await parquet({ generation: 1 });

    expect(current.generation).toBe(2);
    expect(replaced.generation).toBe(1);
    // Its manifest entry and the tombstones that applied to it are both spent.
    expect(replaced.rows).toBeNull();
    expect(replaced.tombstones).toBeNull();
    expect((await drain(await replaced.open())).length).toBe(replaced.bytes);
  });

  it('refuses a generation or a part that never existed', async () => {
    await expect(parquet({ generation: 99 })).rejects.toBeInstanceOf(AggregateNotFound);
    await expect(parquet({ part: 2 })).rejects.toBeInstanceOf(AggregateNotFound);
  });

  it('reads a range of a file, which is how Parquet is read from a distance', async () => {
    const file = await parquet();

    expect((await drain(await file.open({ start: 0, end: 3 }))).toString()).toBe('PAR1');
    const tail = await drain(await file.open({ start: file.bytes - 4, end: file.bytes - 1 }));
    expect(tail.toString()).toBe('PAR1');
  });

  it('deletes a replaced generation only once its grace has passed', async () => {
    const reap = () => world.dispatcher.send(new ReapGenerations());

    expect(await reap()).toBe(0);
    expect((await parquet({ generation: 1 })).generation).toBe(1);

    const { pool } = await openDatabase();
    await pool.query(`UPDATE retired_generation SET reap_after = now() - interval '1 second'`);

    // The data and the vectors of generation one.
    expect(await reap()).toBe(2);
    await expect(parquet({ generation: 1 })).rejects.toBeInstanceOf(ResourceGone);
    expect((await parquet()).generation).toBe(2);
  });

  it('forgets retirements when the table is dropped, so a new table of that name keeps its files', async () => {
    await world.add(ingot, events(20, 1));
    await world.compact(ingot, 'events');

    const { pool } = await openDatabase();
    const retired = () =>
      pool
        .query<{ n: string }>('SELECT count(*) AS n FROM retired_generation')
        .then((result) => Number(result.rows[0]?.n));
    expect(await retired()).toBeGreaterThan(0);

    await world.dispatcher.send(new DropTable(ingot, world.accountId, 'events'));
    expect(await retired()).toBe(0);
  });
});

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
