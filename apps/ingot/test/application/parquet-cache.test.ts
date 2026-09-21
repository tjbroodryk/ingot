import 'reflect-metadata';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { DropTable } from '../../src/contexts/ingots/application/commands/drop-table.command.js';
import { ParquetCache } from '../../src/engine/parquet-cache.js';
import { PgParquetCacheIndex } from '../../src/engine/postgres/pg-parquet-cache-index.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The shared Parquet cache, through the real engine, a real roll-up and the
 * real index in Postgres.
 *
 * The property that matters is the one the whole two-tier design rests on: a
 * query answers the same either side of a roll-up. With a cache in front of the
 * base tier there are now three sides — before the roll-up, the first query
 * after it (a download), and every query after that (a cached read) — and they
 * must all agree.
 */
describe('the parquet cache', () => {
  let world: World;
  let ingot: string;
  let dir: string;

  const notes = (rows: { sha: string; body: string }[]) => ({
    table: 'notes',
    rows: '$[*]',
    key: ['sha'],
    columns: {
      sha: { from: '$.sha', type: ColumnType.Varchar },
      body: { from: '$.body', type: ColumnType.Varchar },
    },
    result: rows,
  });

  const cached = () => readdirSync(dir).filter((name) => name.endsWith('.parquet'));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ingot-cache-world-'));
    world = await makeWorld({
      env: { INGOT_PARQUET_CACHE_BYTES: String(64 * 1024 * 1024), INGOT_PARQUET_CACHE_DIR: dir },
    });
    ingot = await world.ingot('cached');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers the same before a roll-up, on the download after it, and from disk', async () => {
    await world.add(
      ingot,
      notes([
        { sha: 'a', body: 'first' },
        { sha: 'b', body: 'second' },
      ]),
    );
    const statement = 'SELECT sha, body FROM notes ORDER BY sha';
    const before = await world.sql(ingot, statement);
    expect(cached()).toEqual([]);

    await world.compact(ingot, 'notes');
    const downloaded = await world.sql(ingot, statement);
    expect(cached()).toHaveLength(1);
    const fromDisk = await world.sql(ingot, statement);
    expect(cached()).toHaveLength(1);

    expect(downloaded).toEqual(before);
    expect(fromDisk).toEqual(before);
  });

  // Tombstones are applied in the session, over whatever the Parquet came from.
  it('does not bring back rows that were forgotten', async () => {
    await world.forget(ingot, 'notes', "sha = 'a'");
    expect(await world.sql(ingot, 'SELECT sha FROM notes')).toEqual([{ sha: 'b' }]);
  });

  // A table recreated under the same name counts generations from one again,
  // so its first roll-up writes the same object key the dropped table did.
  it('does not serve a dropped table to the one recreated under its name', async () => {
    await world.app.get(ParquetCache).flush();
    await world.dispatcher.send(new DropTable(ingot, world.accountId, 'notes'));

    // Due for deletion the moment the table is gone.
    const { pool } = await openDatabase();
    const dropped = await pool.query<{ cached_at: Date }>(
      `SELECT cached_at FROM parquet_cache_file WHERE object_key LIKE '%/tables/notes/%'`,
    );
    expect(dropped.rows.map((row) => row.cached_at.getTime())).toEqual([0]);

    await world.add(ingot, notes([{ sha: 'z', body: 'recreated' }]));
    await world.compact(ingot, 'notes');

    expect(await world.sql(ingot, 'SELECT sha, body FROM notes')).toEqual([
      { sha: 'z', body: 'recreated' },
    ]);
  });

  // Another replica's sweep, or a volume gone bad, between the check and the read.
  it('reads from the store when a cached file will not read', async () => {
    for (const name of cached()) writeFileSync(join(dir, name), 'not parquet');
    expect(await world.sql(ingot, 'SELECT sha, body FROM notes')).toEqual([
      { sha: 'z', body: 'recreated' },
    ]);
  });

  // The directory holds every tenant's tables; the lockdown is what keeps a
  // caller's SQL out of it.
  it('is out of reach of a caller', async () => {
    const [name] = cached();
    await expect(
      world.sql(ingot, `SELECT * FROM read_parquet('${join(dir, name as string)}')`),
    ).rejects.toThrow();
    await expect(world.sql(ingot, `SELECT * FROM glob('${dir}/*')`)).rejects.toThrow();
  });

  describe('its index in Postgres', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 12, minute));
    const use = (id: string, objectKey: string, bytes: number, minute: number) => ({
      id,
      objectKey,
      bytes,
      cachedAt: at(0),
      usedAt: at(minute),
    });
    let index: PgParquetCacheIndex;

    beforeAll(async () => {
      index = world.app.get(PgParquetCacheIndex);
      const { pool } = await openDatabase();
      await pool.query('DELETE FROM parquet_cache_file');
    });

    // Batches from several replicas land in any order.
    it('only ever moves a last read forward', async () => {
      await index.touch([use('forward', 'k/forward', 10, 30)]);
      await index.touch([use('forward', 'k/forward', 10, 10)]);
      const { pool } = await openDatabase();
      const { rows } = await pool.query(
        `SELECT last_used_at FROM parquet_cache_file WHERE id = 'forward'`,
      );
      expect(rows[0].last_used_at.getTime()).toBe(at(30).getTime());
      await pool.query('DELETE FROM parquet_cache_file');
    });

    it('expires a prefix as a directory, not as a string', async () => {
      await index.touch([
        use('notes', 'a/i/tables/notes/gen-000001/part-0001.parquet', 10, 1),
        use('notes2', 'a/i/tables/notes2/gen-000001/part-0001.parquet', 10, 1),
      ]);
      await index.expirePrefix('a/i/tables/notes');
      // Both cached at minute 0, so only the expired prefix is older than that.
      const evicted = await index.evictExpired(at(0), at(59));
      expect(evicted.map((file) => file.id)).toEqual(['notes']);
      expect(await index.known(['notes', 'notes2'])).toEqual(new Set(['notes2']));
      const { pool } = await openDatabase();
      await pool.query('DELETE FROM parquet_cache_file');
    });

    it('evicts the least recently read idle files, just enough to fit', async () => {
      await index.touch([
        use('oldest', 'k/1', 30, 1),
        use('older', 'k/2', 30, 2),
        use('newer', 'k/3', 30, 3),
        use('in-use', 'k/4', 30, 50),
      ]);
      // 120 bytes down to 70: the two least recently read idle files go, and
      // the one read after `idleBefore` is never a candidate.
      const evicted = await index.evictDownTo(70, at(10));
      expect(evicted.map((file) => [file.id, file.bytes]).sort()).toEqual([
        ['older', 30],
        ['oldest', 30],
      ]);
      expect(await index.totalBytes()).toBe(60);
    });
  });
});
