import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { sessionSql } from '../src/duckdb/index.js';
import type { ColumnInfo, TableSnapshot } from '../src/index.js';

const column = (name: string, type: string): ColumnInfo =>
  ({ name, type, embedded: false, required: true }) as ColumnInfo;

const columns = [
  column('_row_id', 'VARCHAR'),
  column('_ingested_at', 'TIMESTAMP'),
  column('_batch', 'VARCHAR'),
  column('id', 'VARCHAR'),
  column('n', 'BIGINT'),
  column('opened', 'DATE'),
  column('done', 'BOOLEAN'),
  column('labels', 'JSON'),
  // Added after the base file was written: the Parquet has no such column.
  column('late', 'VARCHAR'),
];

describe('sessionSql', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('rebuilds base, overlay and tombstones into the rows /query would see', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingot-sdk-'));
    dirs.push(dir);
    const parquet = join(dir, "part-0001's.parquet");

    const db = await DuckDBInstance.create(':memory:');
    const connection = await db.connect();
    await connection.run(
      `COPY (SELECT * FROM (VALUES
         ('r1', TIMESTAMP '2026-09-01 00:00:00', 'b1', 'T-1', 1::BIGINT, DATE '2026-09-01', true, '["a"]'::JSON),
         ('r2', TIMESTAMP '2026-09-01 00:00:00', 'b1', 'T-2', 2::BIGINT, DATE '2026-09-02', false, NULL::JSON)
       ) v(_row_id, _ingested_at, _batch, id, n, opened, done, labels))
       TO '${parquet.replaceAll("'", "''")}' (FORMAT parquet)`,
    );

    const snapshot: TableSnapshot = {
      table: 'tickets',
      generation: 7,
      base: [{ part: 1, rows: 2, bytes: 0 }],
      columns,
      rows: [
        {
          rowId: 'r3',
          seq: '10',
          ingestedAt: '2026-09-17T10:00:00.000Z',
          // As `/add` coerced and stored them.
          values: {
            _row_id: 'r3',
            _ingested_at: '2026-09-17T10:00:00.000Z',
            _batch: 'b2',
            id: "O'Brien",
            n: 3,
            opened: '2026-09-17',
            done: true,
            labels: '{"k":1}',
            late: 'yes',
          },
        },
        {
          rowId: 'r4',
          seq: '11',
          ingestedAt: '2026-09-17T10:00:00.000Z',
          values: {
            _row_id: 'r4',
            _ingested_at: '2026-09-17T10:00:00.000Z',
            _batch: 'b2',
            id: 'T-4',
          },
        },
      ],
      tombstones: [
        { rowId: 'r2', at: '' },
        { rowId: 'r4', at: '' },
      ],
      cursor: '11',
    };

    const statements = sessionSql(snapshot, {
      as: 'dataset',
      url: (file) => {
        expect(file).toEqual({ table: 'tickets', generation: 7, part: 1 });
        return parquet;
      },
      batchSize: 1,
    });
    for (const statement of statements) await connection.run(statement);

    const result = await connection.runAndReadAll(
      'SELECT id, n, opened, done, labels, late, _ingested_at FROM dataset ORDER BY _row_id',
    );
    expect(result.getRowObjectsJson()).toEqual([
      {
        id: 'T-1',
        n: '1',
        opened: '2026-09-01',
        done: true,
        labels: '["a"]',
        late: null,
        _ingested_at: '2026-09-01 00:00:00',
      },
      {
        id: "O'Brien",
        n: '3',
        opened: '2026-09-17',
        done: true,
        labels: '{"k":1}',
        late: 'yes',
        _ingested_at: '2026-09-17 10:00:00',
      },
    ]);

    // Running a newer snapshot's statements replaces the table rather than failing.
    for (const statement of sessionSql(
      { ...snapshot, base: [], rows: [], tombstones: [] },
      { as: 'dataset' },
    )) {
      await connection.run(statement);
    }
    const emptied = await connection.runAndReadAll('SELECT count(*) AS n FROM dataset');
    expect(emptied.getRowObjectsJson()).toEqual([{ n: '0' }]);
  });

  it('refuses what it cannot render safely', () => {
    const snapshot = {
      table: 't',
      generation: 1,
      base: [{ part: 1, rows: 1, bytes: 1 }],
      columns,
      rows: [],
      tombstones: [],
      cursor: null,
    };
    expect(() => sessionSql(snapshot)).toThrow(TypeError);
    expect(() =>
      sessionSql({ ...snapshot, base: [], columns: [column('x', 'VARCHAR); DROP TABLE y; --')] }),
    ).toThrow(TypeError);
  });

  it('quotes identifiers and never declares a vector column', () => {
    const [create] = sessionSql({
      table: 'a"b',
      generation: 0,
      base: [],
      columns: [column('c"d', 'VARCHAR')],
      rows: [],
      tombstones: [],
      cursor: null,
    });
    expect(create).toBe('CREATE OR REPLACE TABLE "a""b" ("c""d" VARCHAR)');
    expect(create).not.toContain('FLOAT');
  });
});
