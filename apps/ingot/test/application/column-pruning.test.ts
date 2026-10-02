import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { ColumnType } from '@ingot/shared/ingot-v1';
import type { MaterialisableTable } from '../../src/engine/analytical-engine.port.js';
import { FtsSettings } from '../../src/contexts/ingots/domain/table-config.vo.js';
import { columnUsage, pruneTable } from '../../src/engine/column-pruning.js';
import { registry } from '../../src/observability/metrics/registry.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A query session loads only the vectors and `_raw` its statement can need.
 *
 * The half that matters is that nobody can tell: every answer here is one the
 * session would have given with every column loaded. The table is rolled up
 * and then written to again, so both tiers are in play — `_raw` arriving from
 * Parquet through the projection that leaves it out, and from the overlay.
 */
describe('column pruning', () => {
  let world: World;
  let ingot: string;

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an ingot with everything expensive');
    const add = (output: string, tool: string) =>
      world.add(ingot, {
        table: 'results',
        raw: true,
        columns: {
          output: { from: '$.output', type: ColumnType.Varchar, embed: true },
          tool: { from: '$.tool', type: ColumnType.Varchar },
        },
        result: { output, tool },
      });

    await add('the migration broke on a missing index', 'Bash');
    await world.embedAll();
    await world.compact(ingot, 'results');
    await add('the deploy went out cleanly', 'Grep');
    await world.embedAll();
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('answers a query that names neither, from both tiers', async () => {
    const found = await world.query(ingot, { sql: 'SELECT tool FROM results ORDER BY tool' });
    expect(found.rows).toEqual([{ tool: 'Bash' }, { tool: 'Grep' }]);
  });

  it('still hands back _raw to a star, and to a caller who names it', async () => {
    const star = await world.query(ingot, { sql: 'SELECT * FROM results ORDER BY tool' });
    expect(star.columns).toContain('_raw');
    expect(star.columns).not.toContain('output_vec');
    expect(String(star.rows[0]?._raw)).toContain('migration');

    const named = await world.query(ingot, { sql: 'SELECT _raw FROM results ORDER BY tool' });
    expect(String(named.rows[1]?._raw)).toContain('deploy');
  });

  it('still ranks by meaning, across the roll-up', async () => {
    const found = await world.query(ingot, { text: 'a broken migration', table: 'results' });
    expect(found.rows[0]).toMatchObject({ tool: 'Bash' });

    const hybrid = await world.query(ingot, {
      text: 'a broken migration',
      sql:
        'SELECT tool FROM results WHERE output_vec IS NOT NULL ' +
        'ORDER BY array_cosine_similarity(output_vec, $q) DESC',
    });
    expect(hybrid.rows.map((row) => row.tool)).toEqual(['Bash', 'Grep']);
  });

  it("records each session's memory as DuckDB reports it", async () => {
    await world.query(ingot, { sql: 'SELECT count(*) AS n FROM results' });

    const scrape = await registry().getSingleMetricAsString('ingot_session_memory_bytes');
    const count = (phase: string) =>
      Number(
        new RegExp(`_count\\{[^}]*kind="query",phase="${phase}"[^}]*\\} (\\d+)`).exec(scrape)?.[1] ??
          0,
      );
    expect(count('materialised')).toBeGreaterThan(0);
    expect(count('finished')).toBeGreaterThan(0);
  });
});

describe('which columns a statement can need', () => {
  const table: MaterialisableTable = {
    name: 'results',
    columns: [
      { name: '_row_id', type: ColumnType.Varchar },
      { name: '_raw', type: ColumnType.Json },
      { name: 'output', type: ColumnType.Varchar },
    ],
    baseFiles: ['gs://b/base.parquet'],
    vectorFiles: ['gs://b/vec.parquet'],
    sources: [
      { table: 't@1', key: 'base', uri: 'gs://b/base.parquet', bytes: 10 },
      { table: 't@1', key: 'vec', uri: 'gs://b/vec.parquet', bytes: 20 },
    ],
    overlayRows: [],
    overlayVectors: [{ rowId: 'r1', column: 'output', literal: '[1,2]' }],
    tombstones: [],
    embedded: [{ column: 'output', dimensions: 2 }],
    fts: FtsSettings.default().toWire(),
  };

  let parser: DuckDBInstance;
  beforeAll(async () => {
    parser = await DuckDBInstance.create(':memory:');
  });
  afterAll(() => parser?.closeSync());

  async function prunedFor(sql: string): Promise<MaterialisableTable> {
    const connection = await parser.connect();
    const reader = await connection.runAndReadAll(
      `SELECT json_serialize_sql('${sql.replaceAll("'", "''")}') AS tree`,
    );
    const tree = JSON.parse(String(reader.getRowObjectsJson()[0]?.tree));
    return pruneTable(table, columnUsage(sql, tree, [table]));
  }

  it('drops both from a query that names neither', async () => {
    const pruned = await prunedFor('SELECT count(*) FROM results WHERE output IS NOT NULL');
    expect(pruned).toMatchObject({
      columns: [{ name: '_row_id' }, { name: 'output' }],
      embedded: [],
      vectorFiles: [],
      sources: [{ key: 'base' }],
      overlayVectors: [],
    });
  });

  it('keeps a vector the statement names, wherever it names it', async () => {
    for (const sql of [
      'SELECT array_cosine_similarity(output_vec, $q) FROM results',
      'SELECT * EXCLUDE (output_vec) FROM results',
    ]) {
      expect((await prunedFor(sql)).embedded).toEqual(table.embedded);
    }
  });

  it('keeps _raw for anything that can reach it without naming it', async () => {
    for (const sql of [
      'SELECT * FROM results',
      'SELECT r.* FROM results r',
      `SELECT COLUMNS('.*') FROM results`,
      'SELECT to_json(r) FROM results r',
      'SELECT _raw FROM results',
    ]) {
      expect((await prunedFor(sql)).columns).toEqual(table.columns);
    }
  });

  it('keeps everything for a statement whose parse it cannot read', () => {
    const usage = columnUsage('SELECT output FROM results', { error: true }, [table]);
    expect(pruneTable(table, usage).columns).toEqual(table.columns);
  });
});
