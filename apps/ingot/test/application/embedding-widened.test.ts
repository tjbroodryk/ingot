import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Widening a column to `embed` embeds later rows only; earlier rows are not
 * backfilled. Fails if a backfill lands, by design.
 */
describe('turning embedding on after the fact', () => {
  let world: World;
  let ingot: string;

  const body = { from: '$.body', type: ColumnType.Varchar };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory that changed its mind');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('embeds what comes after, and leaves what came before', async () => {
    // Written while the column was plain: nothing queued, no vector.
    const before = await world.add(ingot, {
      table: 'notes',
      columns: { body },
      result: { body: 'stored before anybody wanted this searchable' },
    });
    expect(before.queuedForEmbedding).toBe(0);

    // The widening: accepted, and takes effect from here.
    const after = await world.add(ingot, {
      table: 'notes',
      columns: { body: { ...body, embed: true } },
      result: { body: 'stored once somebody did' },
    });
    expect(after.queuedForEmbedding).toBe(1);

    // One of the two rows embedded; the first is not queued.
    expect(await world.embedAll()).toBe(1);
    expect(await world.embedAll()).toBe(0);

    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');
    expect(Number(rows[0]?.n)).toBe(2);
  });

  // The flag is the table's, so a later write that omits it still embeds.
  it('keeps embedding without being asked again', async () => {
    const quiet = await world.add(ingot, {
      table: 'notes',
      columns: { body },
      result: { body: 'no embed flag on this write at all' },
    });

    expect(quiet.queuedForEmbedding).toBe(1);
    expect(await world.embedAll()).toBe(1);
  });
});
