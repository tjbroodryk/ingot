import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/** Vector columns rank results but are never returned to a caller. */
describe('embeddings', () => {
  let world: World;
  let ingot: string;

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory with vectors in it');
    await world.add(ingot, {
      table: 'notes',
      columns: {
        body: { from: '$.body', type: ColumnType.Varchar, embed: true },
        author: { from: '$.author', type: ColumnType.Varchar },
      },
      result: { body: 'the migration broke on a missing index', author: 'tj' },
    });
    // Vectors are written by the background worker; without this the column
    // would be empty.
    expect(await world.embedAll()).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('are not in a plaintext search, which is where they used to come back', async () => {
    const found = await world.query(ingot, { text: 'the migration broke', table: 'notes' });

    expect(found.rows.length).toBe(1);
    expect(found.columns).not.toContain('body_vec');
    expect(Object.keys(found.rows[0] as object)).not.toContain('body_vec');
    // The ranking still arrives; only the vector is withheld.
    expect(found.rows[0]).toHaveProperty('score');
    expect(found.rows[0]).toHaveProperty('body');
  });

  it('are not in a `SELECT *`', async () => {
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect(found.columns).not.toContain('body_vec');
    for (const row of found.rows) expect(Object.keys(row)).not.toContain('body_vec');
  });

  it('leave a `SELECT *` matching exactly what `/info` promised', async () => {
    const info = await world.info(ingot);
    const declared = info.tables.find((table) => table.name === 'notes')?.columns ?? [];
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect([...found.columns].sort()).toEqual(declared.map((column) => column.name).sort());
  });

  it('are withheld however they are named', async () => {
    // Withheld by type, not name, so an alias does not slip one through.
    const found = await world.query(ingot, {
      sql: 'SELECT author, body_vec AS harmless FROM notes',
    });

    expect(found.columns).toEqual(['author']);
    expect(found.rows[0]).toEqual({ author: 'tj' });
  });

  it('are refused rather than silently emptied when they are all that was asked for', async () => {
    // Withholding every column would answer with keyless rows, which reads as
    // "nothing there".
    await expect(world.query(ingot, { sql: 'SELECT body_vec FROM notes' })).rejects.toThrow(
      /never returned/i,
    );
  });

  it('are still usable by a query that ranks with them', async () => {
    // The column stays in the catalogue; the rule is about the result, not the SQL.
    const found = await world.query(ingot, {
      text: 'the migration broke',
      sql:
        'SELECT author, array_cosine_similarity(body_vec, $q) AS score ' +
        'FROM notes ORDER BY score DESC',
    });

    expect(found.columns).toEqual(['author', 'score']);
    expect(Number(found.rows[0]?.score)).toBeGreaterThan(0);
  });

  it('are not in the rows a plain LIST of the table returns after a roll-up', async () => {
    // A roll-up rebuilds the vector column, so the rule must hold post-compaction too.
    await world.compact(ingot, 'notes');
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect(found.columns).not.toContain('body_vec');
  });
});
