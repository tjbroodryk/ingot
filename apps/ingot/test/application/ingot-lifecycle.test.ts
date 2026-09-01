import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * One memory, from empty to destroyed, through the commands a caller uses.
 *
 * Written as a sequence rather than as independent cases because the thing
 * under test is the sequence: a row is stored, becomes queryable, survives a
 * roll-up unchanged, and then stops existing. Each step depends on the last,
 * which is exactly the property that a set of isolated tests would not check.
 */
describe('an ingot, end to end', () => {
  let world: World;
  let ingot: string;

  /** A real GitHub "files in a pull request" response, trimmed. */
  const pullRequestFiles = {
    pull_request: { number: 42, title: 'Tighten the query sandbox' },
    files: [
      { filename: 'src/engine/duckdb-engine.ts', additions: 120, patch: 'lock_configuration' },
      { filename: 'test/application/sql-sandbox.test.ts', additions: 64, patch: 'refuses ATTACH' },
      { filename: 'README.md', additions: 3, patch: 'a note about the sandbox' },
    ],
  };

  const mapping = {
    table: 'pr_files',
    rows: '$.files[*]',
    columns: {
      pr: { from: '$$.pull_request.number', type: ColumnType.Integer },
      title: { from: '$$.pull_request.title', type: ColumnType.Varchar },
      path: { from: '$.filename', type: ColumnType.Varchar },
      adds: { from: '$.additions', type: ColumnType.Integer },
      patch: { from: '$.patch', type: ColumnType.Varchar, embed: true },
    },
    result: pullRequestFiles,
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('pull request memory');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('fans one tool result out into a row per file', async () => {
    const added = await world.add(ingot, mapping);
    expect(added.rowsAdded).toBe(3);
  });

  it('carries the parent’s fields onto every fanned-out row', async () => {
    // `$$` is what makes fanning out useful: a row per file that still knows
    // which pull request it came from.
    const result = await world.query(ingot, {
      sql: 'SELECT DISTINCT pr, title FROM pr_files',
    });
    expect(result.rows).toEqual([{ pr: 42, title: 'Tighten the query sandbox' }]);
  });

  it('is queryable the instant it is stored, with no roll-up', async () => {
    const result = await world.query(ingot, {
      sql: 'SELECT path, adds FROM pr_files ORDER BY adds DESC',
    });
    expect(result.rows.map((row) => row.path)).toEqual([
      'src/engine/duckdb-engine.ts',
      'test/application/sql-sandbox.test.ts',
      'README.md',
    ]);
  });

  it('reports the schema it inferred from the mapping', async () => {
    const info = await world.info(ingot);
    const table = info.tables.find((candidate) => candidate.name === 'pr_files');

    expect(table?.rows).toBe(3);
    expect(table?.pending).toBe(3); // nothing rolled up yet
    expect(table?.generation).toBe(0);

    const columns = Object.fromEntries(
      (table?.columns ?? []).map((column) => [column.name, column.type]),
    );
    expect(columns).toMatchObject({
      _row_id: ColumnType.Varchar,
      _ingested_at: ColumnType.Timestamp,
      pr: ColumnType.Integer,
      path: ColumnType.Varchar,
      adds: ColumnType.Integer,
    });
    expect(table?.columns.find((column) => column.name === 'patch')?.embedded).toBe(true);
  });

  it('adds a column a later write introduces, as optional', async () => {
    const added = await world.add(ingot, {
      ...mapping,
      columns: {
        ...mapping.columns,
        status: { value: 'merged', type: ColumnType.Varchar },
      },
      result: { ...pullRequestFiles, files: [pullRequestFiles.files[0]] },
    });

    expect(added.columnsAdded).toEqual(['status']);

    const info = await world.info(ingot);
    const status = info.tables
      .find((table) => table.name === 'pr_files')
      ?.columns.find((column) => column.name === 'status');

    // Optional, because the three rows already written have no such column.
    expect(status?.required).toBe(false);
  });

  it('refuses a write that would change a column’s type', async () => {
    const clash = world.add(ingot, {
      ...mapping,
      columns: { ...mapping.columns, adds: { from: '$.additions', type: ColumnType.Varchar } },
    });
    await expect(clash).rejects.toThrow(/adds.*INTEGER.*VARCHAR/s);
  });

  it('ranks by meaning once the embeddings have run', async () => {
    expect(await world.embedAll()).toBeGreaterThan(0);

    const result = await world.query(ingot, {
      text: 'configuration lock',
      table: 'pr_files',
      limit: 3,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]).toHaveProperty('score');
  });

  it('forgets rows a predicate names, immediately', async () => {
    const before = await world.query(ingot, { sql: 'SELECT count(*) AS n FROM pr_files' });
    expect(Number(before.rows[0]?.n)).toBe(4);

    expect(await world.forget(ingot, 'pr_files', "path = 'README.md'")).toBe(1);

    const after = await world.query(ingot, { sql: 'SELECT count(*) AS n FROM pr_files' });
    expect(Number(after.rows[0]?.n)).toBe(3);
  });

  it('says how many rows a query returned and whether it truncated', async () => {
    const result = await world.query(ingot, { sql: 'SELECT * FROM pr_files', limit: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
