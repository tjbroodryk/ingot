import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type CloneIngotBody, ColumnType, DeliveryKind } from '@ingot/shared/ingot-v1';
import { CloneIngot } from '../../src/contexts/ingots/application/commands/clone-ingot.command.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A clone holds what its source held at one instant, in both tiers, and from
 * then on the two share nothing — not rows, not Parquet, not queued work.
 */
describe('cloning a memory', () => {
  let world: World;
  let source: string;

  const notes = (from: number, count: number) => ({
    table: 'notes',
    rows: '$.items[*]',
    columns: {
      n: { from: '$.n', type: ColumnType.Integer },
      note: { from: '$.note', type: ColumnType.Varchar, embed: true },
    },
    key: ['n'],
    result: {
      items: Array.from({ length: count }, (_, at) => ({
        n: from + at,
        note: `note number ${from + at}`,
      })),
    },
  });

  const clone = (ingot: string, body: CloneIngotBody = {}, accountId = world.accountId) =>
    world.dispatcher.send(new CloneIngot(ingot, accountId, body));

  const numbers = async (ingot: string) =>
    (await world.sql(ingot, 'SELECT n FROM notes ORDER BY n')).map((row) => row.n);

  beforeAll(async () => {
    world = await makeWorld();
    source = await world.ingot('the source');

    // Both tiers, and both kinds of pending work: rows 0–4 are rolled up with
    // their vectors, 5–9 wait in the overlay with theirs still owed, and 2 is
    // forgotten after the roll-up so its tombstone is only in the overlay.
    await world.add(source, notes(0, 5));
    await world.embedAll();
    await world.compact(source, 'notes');
    await world.add(source, notes(5, 5));
    await world.forget(source, 'notes', 'n = 2');
    await world.configureIngot(source, {
      delivery: { t: DeliveryKind.Webhook, endpoint: 'https://receiver.test/hook' },
      retainFor: '14d',
    });
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  // First, while the source's five overlay texts are the only ones queued.
  it('carries the embeddings it has and the ones still owed', async () => {
    const { ingot } = await clone(source);
    expect(await world.embedAll()).toBe(10);

    for (const id of [source, ingot.id]) {
      const ranked = await world.query(id, { text: 'note number 7', table: 'notes', limit: 20 });
      expect(ranked.rows.map((row) => row.n).sort()).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
    }
    expect((await world.info(ingot.id)).embedding).toEqual((await world.info(source)).embedding);
  });

  it('answers every query the way the source does', async () => {
    const { ingot, created } = await clone(source, { name: 'the copy' });
    expect(created).toBe(true);
    expect(ingot.id).not.toBe(source);
    expect(ingot.name).toBe('the copy');

    expect(await numbers(ingot.id)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
    expect(await numbers(ingot.id)).toEqual(await numbers(source));

    const [table] = (await world.info(ingot.id)).tables;
    const [original] = (await world.info(source)).tables;
    expect(table).toEqual(original as never);
  });

  it('keeps the source’s name and expiry, and none of its delivery', async () => {
    const { ingot } = await clone(source);
    const info = await world.info(ingot.id);
    const original = await world.info(source);

    expect(ingot.name).toBe('the source');
    expect(info.config.expiresAt).toBe(original.config.expiresAt);
    expect(info.config.delivery).toEqual({ t: DeliveryKind.None });

    const shorter = await clone(source, { retainFor: '1h' });
    expect(Date.parse(shorter.ingot.expiresAt ?? '')).toBeLessThan(
      Date.parse(original.config.expiresAt ?? ''),
    );
  });

  it('shares nothing with the source afterwards, including its Parquet', async () => {
    const scratch = await world.ingot('short lived');
    await world.add(scratch, notes(0, 3));
    await world.compact(scratch, 'notes');
    const { ingot } = await clone(scratch);

    await world.add(ingot.id, notes(100, 1));
    expect(await numbers(scratch)).toEqual([0, 1, 2]);

    await world.destroy(scratch);
    expect(await numbers(ingot.id)).toEqual([0, 1, 2, 100]);
    await world.compact(ingot.id, 'notes');
    expect(await numbers(ingot.id)).toEqual([0, 1, 2, 100]);
  });

  it('is idempotent on externalId', async () => {
    const first = await clone(source, { externalId: 'fork-1' });
    const second = await clone(source, { externalId: 'fork-1', name: 'ignored' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ingot.id).toBe(first.ingot.id);
    expect(second.ingot.name).toBe('the source');
  });

  it('waits for documents still being parsed', async () => {
    const reading = await world.ingot('mid upload');
    await world.file(reading, { filename: 'a.txt', mediaType: 'text/plain', content: 'hello' });

    await expect(clone(reading)).rejects.toThrow(/still being parsed/);

    await world.parseAll();
    const { ingot } = await clone(reading);
    const [file] = await world.sql(ingot.id, 'SELECT filename, status FROM ingot_files');
    expect(file).toEqual({ filename: 'a.txt', status: 'ready' });
  });

  it('will not clone another account’s memory', async () => {
    await expect(clone(source, {}, 'acc_000000000000000000000000')).rejects.toThrow(
      /does not exist/,
    );
  });
});
