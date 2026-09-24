import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, FtsStemmer, FtsStopwords } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/** Keyword search, and the table settings that decide what it finds. */
describe('full text search', () => {
  let world: World;
  let ingot: string;

  const rows = [
    { id: 'a', body: 'the quick brown foxes are running through the woods' },
    { id: 'b', body: 'slow green turtles resting by the water' },
  ];

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory to search');

    for (const row of rows) {
      await world.add(ingot, {
        table: 'notes',
        columns: {
          id: { from: '$.id', type: ColumnType.Varchar },
          body: { from: '$.body', type: ColumnType.Varchar },
        },
        result: row,
      });
    }
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  /** Every one of these searches `notes`; only the term and settings differ. */
  const search = (term: string) =>
    world.sql(
      ingot,
      `SELECT id, fts_main_notes.match_bm25(_row_id, '${term}') AS score
         FROM notes
        WHERE fts_main_notes.match_bm25(_row_id, '${term}') IS NOT NULL
        ORDER BY score DESC`,
    );

  it('loads the extension in every session, whatever the table is set to', async () => {
    // `stem` comes only from `fts`, so this fails if the engine stopped loading it.
    const [stemmed] = await world.sql(ingot, `SELECT stem('running', 'english') AS s`);
    expect(stemmed?.s).toBe('run');
  });

  it('is off until a table asks for it', async () => {
    const info = await world.info(ingot);
    const notes = info.tables.find((table) => table.name === 'notes');

    expect(notes?.config.fts.enabled).toBe(false);
    expect(notes?.config.fts.stemmer).toBe(FtsStemmer.Porter);
    expect(notes?.config.fts.stopwords).toBe(FtsStopwords.English);

    // Nothing was indexed, so the macro the search would call does not exist.
    expect(search('foxes')).rejects.toThrow(/match_bm25/i);
  });

  it('ranks rows once the table is configured for it', async () => {
    await world.configure(ingot, 'notes', { fts: { enabled: true } });

    const found = await search('foxes');
    expect(found.map((row) => row.id)).toEqual(['a']);
    expect(Number(found[0]?.score)).toBeGreaterThan(0);
  });

  it('stems, so a search finds a word it does not literally contain', async () => {
    await world.configure(ingot, 'notes', { fts: { enabled: true, stemmer: FtsStemmer.Porter } });

    // The rows say "running"; the term is "run". Only stemming connects them.
    expect((await search('run')).map((row) => row.id)).toEqual(['a']);

    await world.configure(ingot, 'notes', { fts: { stemmer: FtsStemmer.None } });
    expect(await search('run')).toEqual([]);
  });

  // "the" is an English stopword, so it is not indexed until stopwords are off.
  it('indexes stopwords when told to, and not before', async () => {
    await world.configure(ingot, 'notes', {
      fts: { enabled: true, stemmer: FtsStemmer.None, stopwords: FtsStopwords.English },
    });
    expect(await search('the')).toEqual([]);

    await world.configure(ingot, 'notes', { fts: { stopwords: FtsStopwords.None } });
    expect((await search('the')).map((row) => row.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves the settings a patch does not mention alone', async () => {
    await world.configure(ingot, 'notes', {
      fts: { enabled: true, stemmer: FtsStemmer.None, stopwords: FtsStopwords.None },
    });

    // One field, sent on its own; the other two must survive it.
    const after = await world.configure(ingot, 'notes', { fts: { lowercase: false } });

    expect(after.fts.lowercase).toBe(false);
    expect(after.fts.stemmer).toBe(FtsStemmer.None);
    expect(after.fts.stopwords).toBe(FtsStopwords.None);
    expect(after.fts.enabled).toBe(true);
  });

  it('reports what a table is set to, on the table itself', async () => {
    await world.configure(ingot, 'notes', {
      fts: { enabled: true, columns: ['body'], ignore: '[^a-z0-9]+' },
    });

    const info = await world.info(ingot);
    const notes = info.tables.find((table) => table.name === 'notes');

    expect(notes?.config.fts.enabled).toBe(true);
    expect(notes?.config.fts.columns).toEqual(['body']);
    expect(notes?.config.fts.ignore).toBe('[^a-z0-9]+');
  });

  // The domain rejects bad enum values; an unparsed `stopwords` would let a
  // caller name a table for DuckDB to read.
  it('refuses a stopword list that is not one of the two', async () => {
    expect(
      world.configure(ingot, 'notes', { fts: { stopwords: 'sneaky_table' as FtsStopwords } }),
    ).rejects.toThrow(/fts.stopwords/);

    expect(
      world.configure(ingot, 'notes', { fts: { stemmer: 'klingon' as FtsStemmer } }),
    ).rejects.toThrow(/fts.stemmer/);
  });

  // Default column set is the caller's text; the VARCHAR id columns (`_batch`,
  // `_row_id`) are not indexed.
  it('indexes the caller’s text columns and not the service’s ids', async () => {
    await world.configure(ingot, 'notes', { fts: { enabled: true, stemmer: FtsStemmer.None } });

    const [row] = await world.sql(ingot, 'SELECT _batch FROM notes LIMIT 1');
    const batch = String(row?._batch);
    expect(batch).not.toBe('undefined');

    // The batch id is in the table, in a VARCHAR column, and not in the index.
    expect(await search(batch)).toEqual([]);
    expect((await search('turtles')).map((found) => found.id)).toEqual(['b']);
  });

  it('survives a roll-up, which is where the index is rebuilt from Parquet', async () => {
    await world.configure(ingot, 'notes', { fts: { enabled: true, stemmer: FtsStemmer.Porter } });
    await world.compact(ingot, 'notes');

    expect((await search('foxes')).map((row) => row.id)).toEqual(['a']);
  });
});
