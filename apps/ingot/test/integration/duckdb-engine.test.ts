/**
 * The DuckDB behaviours the query path relies on, so a DuckDB upgrade that
 * changes one fails here. The sandbox assertions are a security boundary.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type DuckDBConnection, DuckDBInstance, StatementType } from '@duckdb/node-api';

let scratch: string;

/**
 * A fresh instance per session: connections to one instance share a catalogue,
 * and `enable_external_access` / `lock_configuration` are instance-wide.
 */
async function openSession(): Promise<{
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run(`CREATE TABLE staged (row_id VARCHAR, pr INTEGER, adds INTEGER)`);
  const appender = await connection.createAppender('staged');
  for (let n = 0; n < 32; n++) {
    appender.appendVarchar(`row_${n}`);
    appender.appendInteger(42);
    n % 7 === 0 ? appender.appendNull() : appender.appendInteger(n);
    appender.endRow();
  }
  appender.flushSync();
  appender.closeSync();
  return { instance, connection };
}

/** Revoke external access, then lock configuration; the order matters. */
async function lockDown(connection: DuckDBConnection): Promise<void> {
  await connection.run(`SET enable_external_access = false`);
  await connection.run(`SET lock_configuration = true`);
}

async function rowsOf(connection: DuckDBConnection, sql: string) {
  return (await connection.runAndReadAll(sql)).getRowObjectsJson();
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ingot-duckdb-test-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the sandbox', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;

  beforeAll(async () => {
    ({ instance, connection } = await openSession());
    await lockDown(connection);
  });
  afterAll(() => instance.closeSync());

  // Each is a way out of the session: filesystem, network, another tenant's
  // Parquet, or the configuration. All must be refused.
  const escapes: ReadonlyArray<readonly [string, string]> = [
    ['writing a file', `COPY (SELECT 1) TO '/tmp/ingot-leak.csv'`],
    ['reading a local file', `SELECT * FROM read_csv('/etc/passwd')`],
    ['reading arbitrary parquet', `SELECT * FROM read_parquet('/tmp/somebody-else.parquet')`],
    ['reaching the network', `SELECT * FROM read_csv('https://example.com/x.csv')`],
    ['installing an extension', `INSTALL spatial`],
    ['attaching a database file', `ATTACH 'smuggled.db' AS ondisk`],
    ['restoring external access', `SET enable_external_access = true`],
    ['releasing the lock', `SET lock_configuration = false`],
  ];

  it.each(escapes)('refuses %s', async (_label, sql) => {
    expect(connection.run(sql)).rejects.toThrow();
  });

  it('leaves the materialised tables readable', async () => {
    const [row] = await rowsOf(connection, 'SELECT count(*) AS n FROM staged');
    expect(Number(row?.n)).toBe(32);
  });

  it('leaves information_schema readable, which /info depends on', async () => {
    const columns = await rowsOf(
      connection,
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'staged' ORDER BY ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['row_id', 'pr', 'adds']);
  });

  // The lockdown does not close an in-memory ATTACH (no filesystem, no network),
  // which is why the statement allowlist below is load-bearing.
  it('does NOT contain an in-memory ATTACH', async () => {
    await connection.run(`ATTACH ':memory:' AS smuggled`);
    await connection.run(`CREATE TABLE smuggled.evil AS SELECT * FROM range(100)`);
    const [row] = await rowsOf(connection, 'SELECT count(*) AS n FROM smuggled.evil');
    expect(Number(row?.n)).toBe(100);
    await connection.run(`DETACH smuggled`);
  });
});

describe('the statement allowlist', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    // prepare() binds as well as parses, so a statement naming a missing table
    // throws instead of reporting its type; the allowlist check runs after
    // tables are materialised.
    await connection.run(`CREATE TABLE staged (row_id VARCHAR, pr INTEGER)`);
  });
  afterAll(() => instance.closeSync());

  // The type is read from the parse tree without executing the statement.
  it.each([
    ['SELECT 1', StatementType.SELECT],
    [`COPY (SELECT 1) TO '/tmp/x.csv'`, StatementType.COPY],
    [`ATTACH ':memory:' AS x`, StatementType.ATTACH],
    ['CREATE TABLE t (a INT)', StatementType.CREATE],
    ['DROP TABLE staged', StatementType.DROP],
    ['SET memory_limit = 1', StatementType.SET],
    ['INSTALL spatial', StatementType.LOAD], // INSTALL and LOAD share a type
    ['DELETE FROM staged', StatementType.DELETE],
  ])('reads %s as its true type without running it', async (sql, expected) => {
    const prepared = await connection.prepare(sql);
    try {
      expect(prepared.statementType).toBe(expected);
    } finally {
      prepared.destroySync();
    }
  });

  it('counts chained statements, so only one can be let through', async () => {
    expect((await connection.extractStatements('SELECT 1')).count).toBe(1);
    expect((await connection.extractStatements('SELECT 1; DROP TABLE staged;')).count).toBe(2);
  });
});

describe('getTableNames, which decides what to materialise', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
  });
  afterAll(() => instance.closeSync());

  // Called against an empty catalogue, before the tables are built.
  it('names tables that do not exist yet', () => {
    expect([...connection.getTableNames('SELECT * FROM absent_a, absent_b', false)].sort()).toEqual(
      ['absent_a', 'absent_b'],
    );
  });

  // A USING join and an unparseable query both extract nothing, so an empty
  // result must mean "materialise everything", not "no tables needed".
  it('returns nothing for a USING join, indistinguishably from a bad query', () => {
    expect(connection.getTableNames('SELECT * FROM a JOIN b USING (sha)', false)).toEqual([]);
    expect(connection.getTableNames('SELECT FROM WHERE', false)).toEqual([]);
  });
});

describe('reading the base tier', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  beforeAll(async () => {
    ({ instance, connection } = await openSession());
  });
  afterAll(() => instance.closeSync());

  // Without union_by_name, an older file missing a column is a schema mismatch;
  // with it, the column reads as null.
  it('unions Parquet generations of differing shape', async () => {
    const older = join(scratch, 'gen-0001.parquet');
    const newer = join(scratch, 'gen-0002.parquet');
    await connection.run(
      `COPY (SELECT row_id, pr, adds FROM staged) TO '${older}' (FORMAT PARQUET, COMPRESSION zstd)`,
    );
    await connection.run(
      `COPY (SELECT 'later' AS row_id, 99 AS pr, 1 AS adds, 'added later' AS note)
       TO '${newer}' (FORMAT PARQUET, COMPRESSION zstd)`,
    );

    const [row] = await rowsOf(
      connection,
      `SELECT count(*) AS n, count(note) AS with_note
       FROM read_parquet(['${older}', '${newer}'], union_by_name := true)`,
    );
    expect(Number(row?.n)).toBe(33);
    expect(Number(row?.with_note)).toBe(1);
  });

  // Base ∪ overlay, the shape of every query.
  it('unions the base with the overlay by name', async () => {
    const base = join(scratch, 'base.parquet');
    await connection.run(
      `COPY (SELECT row_id, pr, adds FROM staged) TO '${base}' (FORMAT PARQUET, COMPRESSION zstd)`,
    );
    const [row] = await rowsOf(
      connection,
      `SELECT count(*) AS n FROM (
         SELECT * FROM read_parquet('${base}')
         UNION ALL BY NAME
         SELECT row_id, pr, adds FROM staged)`,
    );
    expect(Number(row?.n)).toBe(64);
  });

  it('round trips nulls through the appender', async () => {
    const [row] = await rowsOf(
      connection,
      'SELECT count(*) AS n, count(adds) AS present FROM staged',
    );
    expect(Number(row?.n)).toBe(32);
    expect(Number(row?.present)).toBe(27); // every 7th row was appended null
  });
});

describe('vector search', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
  });
  afterAll(() => instance.closeSync());

  // No `vss`/HNSW (that index needs a persisted file); brute-force cosine
  // similarity is core DuckDB.
  it('scores fixed-width FLOAT[N] arrays without the vss extension', async () => {
    const [row] = await rowsOf(
      connection,
      `SELECT array_cosine_similarity([1.0, 2.0, 3.0]::FLOAT[3], [1.0, 2.0, 3.0]::FLOAT[3]) AS identical,
              array_cosine_similarity([1.0, 0.0, 0.0]::FLOAT[3], [0.0, 1.0, 0.0]::FLOAT[3]) AS orthogonal`,
    );
    expect(Number(row?.identical)).toBeCloseTo(1, 6);
    expect(Number(row?.orthogonal)).toBeCloseTo(0, 6);
  });

  it('orders by similarity to a bound query vector', async () => {
    await connection.run(`CREATE TABLE memories (body VARCHAR, vec FLOAT[3])`);
    await connection.run(`INSERT INTO memories VALUES
      ('a near miss', [0.9, 0.1, 0.0]), ('unrelated', [0.0, 0.0, 1.0]), ('the match', [1.0, 0.0, 0.0])`);
    const ranked = await rowsOf(
      connection,
      `SELECT body FROM memories
       ORDER BY array_cosine_similarity(vec, [1.0, 0.0, 0.0]::FLOAT[3]) DESC`,
    );
    expect(ranked.map((r) => r.body)).toEqual(['the match', 'a near miss', 'unrelated']);
  });
});

describe('generated SQL', () => {
  // Column names come from a caller's mapping and can be keywords like `at`, so
  // every emitted identifier is quoted.
  it('needs every identifier quoted, because callers pick the names', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    expect(connection.run(`CREATE TABLE unquoted (id INT, at TIMESTAMP)`)).rejects.toThrow(
      /syntax error/i,
    );
    await connection.run(`CREATE TABLE quoted (id INT, "at" TIMESTAMP)`);
    await connection.run(`INSERT INTO quoted VALUES (1, '2026-08-26 09:00:00')`);
    const [row] = await rowsOf(connection, `SELECT "at" FROM quoted`);
    expect(row?.at).toBe('2026-08-26 09:00:00');
  });
});

describe('resource limits', () => {
  it('cancels a running query on interrupt, which is how the timeout works', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const running = connection.runAndReadAll('SELECT count(*) FROM range(500_000_000_000)');
    setTimeout(() => connection.interrupt(), 200);
    expect(running).rejects.toThrow(/interrupt/i);
  });
});
