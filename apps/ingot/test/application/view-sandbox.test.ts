import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The sandbox, for a session that reads its Parquet through views.
 *
 * Such a session keeps its files readable after the lockdown, so the files
 * are readable by the caller's SQL too, and read directly they still hold the
 * forgotten row and the raw vectors. Only the allowlist of what FROM may read
 * stands between the two. Each attack here was a working read against an
 * allowlisted file before that check existed.
 */
describe('the query sandbox, over views', () => {
  let world: World;
  let ingot: string;
  let files: string[];

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an ingot read through views');
    await world.add(ingot, {
      table: 'notes',
      rows: '$[*]',
      key: ['sha'],
      columns: {
        sha: { from: '$.sha', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar, embed: true },
      },
      result: [
        { sha: 'a', body: 'forgotten' },
        { sha: 'b', body: 'kept' },
      ],
    });
    await world.embedAll();
    await world.compact(ingot, 'notes');
    await world.forget(ingot, 'notes', "sha = 'a'");
    files = parquetUnder(world.dataDir);
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('is reading a view, which is what makes the rest worth asking', async () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(
      await world.sql(
        ingot,
        "SELECT table_type FROM information_schema.tables WHERE table_name = 'notes'",
      ),
    ).toEqual([{ table_type: 'VIEW' }]);
    expect(await world.sql(ingot, 'SELECT sha FROM notes')).toEqual([{ sha: 'b' }]);
  });

  const quote = (path: string) => `'${path}'`;
  const attacks: ReadonlyArray<readonly [string, (path: string) => string]> = [
    ['read_parquet of the file', (path) => `SELECT * FROM read_parquet(${quote(path)})`],
    ['the path as a table', (path) => `SELECT * FROM ${quote(path)}`],
    ['the path as a quoted identifier', (path) => `SELECT * FROM "${path}"`],
    ['the path in a subquery', (path) => `SELECT (SELECT count(*) FROM ${quote(path)}) AS n`],
    ['the path in a join', (path) => `SELECT * FROM notes, ${quote(path)}`],
    [
      'the path built at runtime and run by query()',
      (path) =>
        `SELECT * FROM query('SELECT * FROM read_parquet(' || chr(39) || ${quote(path)} || chr(39) || ')')`,
    ],
    ['parquet_metadata', (path) => `SELECT * FROM parquet_metadata(${quote(path)})`],
    ['parquet_schema', (path) => `SELECT * FROM parquet_schema(${quote(path)})`],
    ['read_blob', (path) => `SELECT * FROM read_blob(${quote(path)})`],
    ['read_text', (path) => `SELECT * FROM read_text(${quote(path)})`],
    ['glob', (path) => `SELECT * FROM glob(${quote(join(path, '..', '*'))})`],
  ];

  it.each(attacks)('refuses %s', async (_label, attack) => {
    for (const path of files) {
      await expect(world.query(ingot, { sql: attack(path) })).rejects.toThrow(/nothing else/);
    }
  });

  it.each([
    ['the overlay behind the view', 'SELECT * FROM _ingot.notes_rows'],
    ['the tombstones', 'SELECT * FROM _ingot.notes_forgotten'],
    ['the same, fully qualified', 'SELECT * FROM memory._ingot.notes_forgotten'],
    ['another catalogue', 'SELECT * FROM system.main.duckdb_settings'],
    ['the view definitions', 'SELECT * FROM duckdb_views()'],
    ['the settings', 'SELECT * FROM duckdb_settings()'],
  ])('refuses %s', async (_label, sql) => {
    await expect(world.query(ingot, { sql })).rejects.toThrow(/nothing else/);
  });

  it('still allows what generates rows rather than reading them', async () => {
    const generated = await world.sql(
      ingot,
      'SELECT count(*) AS n FROM range(3), generate_series(1, 2), unnest([1, 2]) AS u(x)',
    );
    expect(Number(generated[0]?.n)).toBe(12);

    const qualified = await world.sql(
      ingot,
      'WITH kept AS (SELECT sha FROM main.notes) ' +
        'SELECT k.sha FROM kept k JOIN memory.main.notes n USING (sha)',
    );
    expect(qualified).toEqual([{ sha: 'b' }]);
  });
});

function parquetUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.parquet')) found.push(path);
    }
  };
  walk(root);
  return found;
}
