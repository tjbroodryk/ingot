import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../src/contexts/records/application/ports/overlay-store.port.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A query reads the overlay vectors it names, and no others.
 *
 * Reading them was most of what a query against an unrolled table cost, and a
 * statement that never names `<column>_vec` had them pruned straight after.
 */
describe('which overlay vectors a query reads', () => {
  let world: World;
  let ingot: string;
  let reads: string[];

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('vectors in the overlay');
    await world.add(ingot, {
      table: 'notes',
      columns: {
        body: { from: '$.body', type: ColumnType.Varchar, embed: true },
        author: { from: '$.author', type: ColumnType.Varchar },
      },
      result: { body: 'the migration broke on a missing index', author: 'tj' },
    });
    expect(await world.embedAll()).toBeGreaterThan(0);

    const overlay = world.app.get<OverlayStore>(OVERLAY_STORE);
    const readVectors = overlay.readVectors.bind(overlay);
    reads = [];
    overlay.readVectors = (tableId: string, column: string) => {
      reads.push(column);
      return readVectors(tableId, column);
    };
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('reads none for a statement that never names one', async () => {
    reads.length = 0;
    expect(await world.sql(ingot, 'SELECT author FROM notes')).toEqual([{ author: 'tj' }]);
    await world.query(ingot, { sql: 'SELECT * FROM notes' });
    expect(reads).toEqual([]);
  });

  it('reads the one a search ranks by, and ranks with it', async () => {
    reads.length = 0;
    const found = await world.query(ingot, {
      text: 'the migration broke on a missing index',
      table: 'notes',
    });
    expect(reads).toEqual(['body']);
    // The same text embeds to the same vector, so this is the literal surviving the trip.
    expect(Number((found.rows[0] as { score: number }).score)).toBeCloseTo(1, 5);
  });

  it('reads it for a hybrid query that names it', async () => {
    reads.length = 0;
    const found = await world.query(ingot, {
      text: 'missing index',
      sql: "SELECT author, array_cosine_similarity(body_vec, $q) AS s FROM notes WHERE author = 'tj'",
    });
    expect(reads).toEqual(['body']);
    expect(Number((found.rows[0] as { s: number }).s)).toBeGreaterThan(0);
  });
});
