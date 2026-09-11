import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A roll-up must not spend the embedding queue.
 *
 * Embedding is asynchronous on purpose — a tool result is queryable the instant
 * it is accepted, without waiting on a model that may be a network away — which
 * means a row can be folded into Parquet before anybody has bought a vector for
 * it. `drain` used to delete the queued text for every row a compaction
 * consumed, on the assumption that a consumed row is an embedded one. When the
 * embedder was behind, that assumption cost the vector outright: the row landed
 * in the base tier with nothing to rank it by, and nothing left to produce one.
 *
 * The failure was invisible from every side. No error; a semantic search that
 * simply returned fewer rows than it should; and `ingot_embeddings_pending`
 * going *down* as the work was discarded, so the one gauge that could have said
 * "the embedder is behind" said the opposite.
 *
 * `rollup-equivalence.test.ts` calls `embedAll()` before every roll-up, which
 * is the ordering that hides this. This file is the one that does not.
 *
 * Its own file because `makeWorld` truncates: a second world built inside
 * another's run takes the first one's account with it.
 */
describe('a roll-up that outruns the embedder', () => {
  let world: World;
  let ingot: string;

  const note = { from: '$.note', type: ColumnType.Varchar, embed: true };

  const notes = (count: number, offset = 0) => ({
    table: 'notes',
    rows: '$.items[*]',
    columns: { n: { from: '$.n', type: ColumnType.Integer }, note },
    result: {
      items: Array.from({ length: count }, (_, index) => ({
        n: offset + index,
        note: `note number ${offset + index}`,
      })),
    },
  });

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory rolled up in a hurry');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('still owes the embeddings it had not bought yet', async () => {
    const written = await world.add(ingot, notes(5));
    expect(written.queuedForEmbedding).toBe(5);

    // The compaction happens first, which is the whole point: these five rows
    // move into Parquet with no vector attached to any of them.
    await world.compact(ingot, 'notes');
    expect((await world.info(ingot)).tables.find((table) => table.name === 'notes')?.pending).toBe(
      0,
    );

    // The queue survived the roll-up. Before this fix it returned 0 — the work
    // had been deleted along with the rows it belonged to.
    expect(await world.embedAll()).toBe(5);
  });

  it('ranks the rows it embedded late', async () => {
    const ranked = await world.query(ingot, { text: 'note number 3', table: 'notes', limit: 3 });

    // A vector written after its row reached the base tier attaches by
    // `_row_id` like any other — the tier a row is in was never part of that
    // join, and this is what proves it.
    expect(ranked.rows.length).toBeGreaterThan(0);
    expect(ranked.rows[0]).toHaveProperty('score');
  });

  it('folds those vectors into the sibling file on the next roll-up', async () => {
    // Something to roll up: a compaction with no rows and no tombstones is a
    // no-op and would prove nothing about the vectors sitting in the overlay.
    await world.add(ingot, notes(5, 5));
    await world.embedAll();
    await world.compact(ingot, 'notes');

    const ranked = await world.query(ingot, { text: 'note number 3', table: 'notes', limit: 10 });
    expect(ranked.rows.length).toBe(10);

    // And the overlay is empty afterwards — both the vectors this compaction
    // folded in and the ones the previous one left behind are in Parquet now.
    expect(await world.embedAll()).toBe(0);
  });

  /**
   * The other way a queued text is allowed to leave, and the reason the drain
   * can stop sweeping the queue without leaking one.
   */
  it('drops the queued text of a row that is forgotten first', async () => {
    await world.add(ingot, notes(4, 100));
    expect(await world.forget(ingot, 'notes', 'n >= 102')).toBe(2);

    // Two of the four are gone before anybody embedded them, and nobody pays a
    // model to describe a row no query can reach.
    expect(await world.embedAll()).toBe(2);
  });
});
