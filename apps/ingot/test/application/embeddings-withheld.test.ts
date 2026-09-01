import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * An embedding is how this service ranks. It is never something a caller reads.
 *
 * The rule is worth a file of its own because the leak is silent and it is
 * expensive in exactly the place this service exists to serve. A vector column
 * is a real column in the materialised catalogue — it has to be, or a hybrid
 * search could not name it — so every `SELECT *` used to hand back a few
 * thousand floats per row. Nothing errors, the answer looks right, and a model
 * reading it pays for the whole array by the token and gets nothing back.
 *
 * The second reason is honesty: `/info` reports the manifest, which has no
 * vector columns in it. A result carrying one is a result whose shape the
 * caller was never told about.
 */
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
    // Vectors are written by the background worker, so nothing here is testing
    // an empty column: without this the leak would have nothing to leak.
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
    // The ranking itself still arrives — withholding the vector is not
    // withholding the answer.
    expect(found.rows[0]).toHaveProperty('score');
    expect(found.rows[0]).toHaveProperty('body');
  });

  it('are not in a `SELECT *`', async () => {
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect(found.columns).not.toContain('body_vec');
    for (const row of found.rows) expect(Object.keys(row)).not.toContain('body_vec');
  });

  it('leave a `SELECT *` matching exactly what `/info` promised', async () => {
    // The strongest form of the rule: the shape of a result is the shape of
    // the schema, with no column the caller was not told about.
    const info = await world.info(ingot);
    const declared = info.tables.find((table) => table.name === 'notes')?.columns ?? [];
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect([...found.columns].sort()).toEqual(declared.map((column) => column.name).sort());
  });

  it('are withheld however they are named', async () => {
    // By type, not by name. An alias is the same leak, and it is not something
    // that can be spelled in advance.
    const found = await world.query(ingot, {
      sql: 'SELECT author, body_vec AS harmless FROM notes',
    });

    expect(found.columns).toEqual(['author']);
    expect(found.rows[0]).toEqual({ author: 'tj' });
  });

  it('are refused rather than silently emptied when they are all that was asked for', async () => {
    // Withholding every column would otherwise answer with rows that have no
    // keys — which reads as "there is nothing there" and is the one failure
    // mode worse than the leak.
    await expect(world.query(ingot, { sql: 'SELECT body_vec FROM notes' })).rejects.toThrow(
      /never returned/i,
    );
  });

  it('are still usable by a query that ranks with them', async () => {
    // The column stays in the catalogue. Not returning it is a rule about the
    // result, not a rule about the SQL — the hybrid search in the README has
    // to keep working.
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
    // A roll-up moves vectors into a sibling Parquet and joins them back on
    // `_row_id`. The column is rebuilt on the way in, so the rule has to hold
    // on the other side of a compaction too.
    await world.compact(ingot, 'notes');
    const found = await world.query(ingot, { sql: 'SELECT * FROM notes' });

    expect(found.columns).not.toContain('body_vec');
  });
});
