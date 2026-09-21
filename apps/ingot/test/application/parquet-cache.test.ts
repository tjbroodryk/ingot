import 'reflect-metadata';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { DropTable } from '../../src/contexts/ingots/application/commands/drop-table.command.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The local Parquet cache, through the real engine and a real roll-up.
 *
 * The property that matters is the one the whole two-tier design rests on: a
 * query answers the same either side of a roll-up. With a cache in front of the
 * base tier there are now three sides — before the roll-up, the first query
 * after it (a download), and every query after that (a local read) — and they
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
    await world.dispatcher.send(new DropTable(ingot, world.accountId, 'notes'));
    await world.add(ingot, notes([{ sha: 'z', body: 'recreated' }]));
    await world.compact(ingot, 'notes');

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
});
