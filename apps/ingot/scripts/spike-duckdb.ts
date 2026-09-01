/**
 * Phase 0 — does DuckDB work under Bun, and does the query sandbox hold?
 *
 * The whole of Ingot rests on two claims that were assumptions when the plan
 * was written: that `@duckdb/node-api` (a native N-API addon) runs under Bun
 * at all, and that `enable_external_access=false` + `lock_configuration=true`
 * actually contains hostile SQL. Neither is worth discovering in Phase 2.
 *
 * Run under both runtimes; they must agree:
 *   bun apps/ingot/scripts/spike-duckdb.ts
 *   node --experimental-strip-types apps/ingot/scripts/spike-duckdb.ts
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, StatementType, type DuckDBConnection } from '@duckdb/node-api';

type Check = { name: string; ok: boolean; note: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, note = ''): void {
  checks.push({ name, ok, note });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${note ? ` — ${note}` : ''}\n`);
}

async function check(name: string, work: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await work());
  } catch (error) {
    record(
      name,
      false,
      error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
    );
  }
}

/** Inverted: the statement is expected to be refused. A success here is the failure. */
async function refuses(connection: DuckDBConnection, label: string, sql: string): Promise<void> {
  try {
    await connection.run(sql);
    record(`sandbox refuses ${label}`, false, 'STATEMENT SUCCEEDED — not contained');
  } catch (error) {
    const [message = ''] = error instanceof Error ? error.message.split('\n') : [String(error)];
    record(`sandbox refuses ${label}`, true, message.slice(0, 80));
  }
}

/** The first row of a query, as plain JSON. Every check here reads exactly one. */
async function one(connection: DuckDBConnection, sql: string): Promise<Record<string, unknown>> {
  const [row] = (await connection.runAndReadAll(sql)).getRowObjectsJson();
  if (!row) throw new Error(`no rows from: ${sql}`);
  return row;
}

const scratch = mkdtempSync(join(tmpdir(), 'ingot-spike-'));

async function main(): Promise<void> {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const runtime = bun ? `bun ${bun.version}` : `node ${process.version}`;
  process.stdout.write(`\n── DuckDB spike on ${runtime} ──\n\n`);

  // ── 1. the addon loads and answers at all ──────────────────────────────
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  await check('instance + connection + query', async () => {
    return String((await one(connection, 'SELECT version() AS v')).v);
  });

  await check('create / insert / select round trip', async () => {
    // "at" and "start" are DuckDB keywords. A caller will name a column that way
    // sooner or later, so every generated identifier is quoted, everywhere.
    await connection.run(`CREATE TABLE probe (id INTEGER, name VARCHAR, "at" TIMESTAMP)`);
    await connection.run(`INSERT INTO probe VALUES (1, 'anvil', '2026-08-26 09:00:00')`);
    const rows = (await connection.runAndReadAll('SELECT * FROM probe')).getRowObjectsJson();
    if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
    return JSON.stringify(rows[0]);
  });

  // ── 2. the appender — how overlay rows get into a query session ────────
  await check('appender writes typed rows', async () => {
    await connection.run(`CREATE TABLE staged (row_id VARCHAR, pr INTEGER, adds INTEGER)`);
    const appender = await connection.createAppender('staged');
    for (let n = 0; n < 500; n++) {
      appender.appendVarchar(`row_${n}`);
      appender.appendInteger(42);
      n % 7 === 0 ? appender.appendNull() : appender.appendInteger(n);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
    const row = await one(connection, 'SELECT count(*) AS n, count(adds) AS non_null FROM staged');
    if (Number(row.n) !== 500) throw new Error(`expected 500 rows, got ${row.n}`);
    return `500 rows, ${row.non_null} non-null (nulls survive)`;
  });

  // ── 3. parquet: write, read back, and union files of differing shape ───
  const genA = join(scratch, 'gen-a.parquet');
  const genB = join(scratch, 'gen-b.parquet');

  await check('COPY … TO parquet (zstd)', async () => {
    await connection.run(
      `COPY (SELECT row_id, pr, adds FROM staged) TO '${genA}' (FORMAT PARQUET, COMPRESSION zstd)`,
    );
    return genA;
  });

  await check('read_parquet round trips', async () => {
    const row = await one(connection, `SELECT count(*) AS n FROM read_parquet('${genA}')`);
    return `${row.n} rows back`;
  });

  await check('union_by_name across evolved schemas', async () => {
    // gen-b has a column gen-a never had: this is schema evolution in the base tier.
    await connection.run(
      `COPY (SELECT 'later' AS row_id, 99 AS pr, 1 AS adds, 'new column' AS note)
       TO '${genB}' (FORMAT PARQUET, COMPRESSION zstd)`,
    );
    const row = await one(
      connection,
      `SELECT count(*) AS n, count(note) AS with_note
       FROM read_parquet(['${genA}', '${genB}'], union_by_name := true)`,
    );
    if (Number(row.n) !== 501) throw new Error(`expected 501, got ${row.n}`);
    return `${row.n} rows, ${row.with_note} carrying the added column`;
  });

  await check('UNION ALL BY NAME (base ∪ overlay)', async () => {
    const row = await one(
      connection,
      `SELECT count(*) AS n FROM (
         SELECT * FROM read_parquet('${genA}')
         UNION ALL BY NAME
         SELECT row_id, pr, adds FROM staged
       )`,
    );
    return `${row.n} rows`;
  });

  // ── 4. vectors without a persisted index ──────────────────────────────
  await check('array_cosine_similarity on FLOAT[N], no vss', async () => {
    const row = await one(
      connection,
      `SELECT array_cosine_similarity([1.0, 2.0, 3.0]::FLOAT[3], [1.0, 2.0, 3.0]::FLOAT[3]) AS same,
              array_cosine_similarity([1.0, 0.0, 0.0]::FLOAT[3], [0.0, 1.0, 0.0]::FLOAT[3]) AS orthogonal`,
    );
    if (Math.abs(Number(row.same) - 1) > 1e-6) throw new Error(`self-similarity was ${row.same}`);
    return `identical=${row.same}, orthogonal=${row.orthogonal}`;
  });

  // ── 5. the pre-execution checks the sandbox leans on ──────────────────
  await check('prepare() exposes statementType before running', async () => {
    const statements = [
      'SELECT * FROM probe',
      `COPY (SELECT 1) TO '${join(scratch, 'x.csv')}'`,
      'DROP TABLE probe',
    ];
    const types: number[] = [];
    for (const sql of statements) {
      const prepared = await connection.prepare(sql);
      types.push(prepared.statementType);
      prepared.destroySync();
    }
    const [select, copy, drop] = types;
    if (select !== StatementType.SELECT) throw new Error(`SELECT read as ${select}`);
    if (copy !== StatementType.COPY) throw new Error(`COPY read as ${copy}`);
    return `SELECT=${select}, COPY=${copy}, DROP=${drop} — all before execution`;
  });

  await check('extractStatements counts multi-statement input', async () => {
    const one = await connection.extractStatements('SELECT 1');
    const three = await connection.extractStatements('SELECT 1; SELECT 2; DROP TABLE probe;');
    if (three.count !== 3) throw new Error(`expected 3, got ${three.count}`);
    return `single=${one.count}, chained=${three.count}`;
  });

  // getTableNames() decides which of an ingot's tables a query needs, so we do
  // not materialise all of them every time. It works against an empty catalog,
  // which is the case that matters \u2014 we ask before creating anything. But it
  // returns [] for any JOIN ... USING (...), and [] is also what an unparseable
  // query returns, so [] is ambiguous between "no tables" and "I could not read
  // this". It is therefore a hint, never an authority: narrow when it reports
  // something, materialise everything when it reports nothing, and retry wide
  // if the query still raises a catalog error.
  await check('getTableNames() reads tables from an empty catalog', async () => {
    const names = connection.getTableNames('SELECT a.id FROM absent_a a, absent_b b', false);
    if (!names.includes('absent_a') || !names.includes('absent_b')) {
      throw new Error(`expected both tables, got ${JSON.stringify(names)}`);
    }
    return JSON.stringify(names);
  });

  await check('getTableNames() returns [] for USING joins (documented trap)', async () => {
    const using = connection.getTableNames('SELECT * FROM probe JOIN ci_runs USING (sha)', false);
    const invalid = connection.getTableNames('SELECT FROM WHERE', false);
    if (using.length > 0)
      throw new Error(`USING works now: ${JSON.stringify(using)} \u2014 revisit`);
    if (invalid.length > 0) throw new Error(`unparseable returned ${JSON.stringify(invalid)}`);
    return 'both [] \u2014 indistinguishable, so [] must mean "materialise everything"';
  });

  await check('interrupt() cancels a running query', async () => {
    const running = connection.runAndReadAll('SELECT count(*) FROM range(500_000_000_000)');
    setTimeout(() => connection.interrupt(), 250);
    try {
      await running;
      throw new Error('query completed — interrupt did nothing');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupt/i.test(message)) return 'cancelled as expected';
      throw new Error(`failed for the wrong reason: ${message.split('\n')[0]}`);
    }
  });

  // ── 6. httpfs, for the bucket tier ────────────────────────────────────
  await check('INSTALL + LOAD httpfs', async () => {
    await connection.run('INSTALL httpfs');
    await connection.run('LOAD httpfs');
    return JSON.stringify(
      await one(
        connection,
        `SELECT extension_name, installed, loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'`,
      ),
    );
  });

  await check('CREATE SECRET (S3, path-style for MinIO)', async () => {
    await connection.run(`CREATE OR REPLACE SECRET spike (
      TYPE S3, KEY_ID 'minioadmin', SECRET 'minioadmin',
      ENDPOINT 'localhost:9000', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')`);
    return 'accepted';
  });

  // ── 7. THE claim: does locking down actually contain hostile SQL? ─────
  process.stdout.write('\n  … locking the session down\n');
  await connection.run(`SET enable_external_access = false`);
  await connection.run(`SET lock_configuration = true`);

  await refuses(connection, 'COPY … TO file', `COPY (SELECT 1) TO '${join(scratch, 'leak.csv')}'`);
  await refuses(connection, 'read_csv of a local file', `SELECT * FROM read_csv('/etc/passwd')`);
  await refuses(
    connection,
    "read_parquet of another tenant's prefix",
    `SELECT * FROM read_parquet('${genA}')`,
  );
  await refuses(connection, 'INSTALL', `INSTALL spatial`);
  await refuses(connection, 'ATTACH of a file', `ATTACH 'smuggled.db' AS ondisk`);
  await refuses(connection, 'un-setting external access', `SET enable_external_access = true`);
  await refuses(connection, 'un-setting the lock', `SET lock_configuration = false`);
  await refuses(connection, 'a remote read', `SELECT * FROM read_csv('https://example.com/x.csv')`);

  // The hole the lockdown does not close, and the layer that does.
  await check("ATTACH ':memory:' SURVIVES the lockdown", async () => {
    await connection.run(`ATTACH ':memory:' AS smuggled`);
    await connection.run(`CREATE TABLE smuggled.evil AS SELECT * FROM range(1000)`);
    await connection.run(`DETACH smuggled`);
    return 'allowed \u2014 an in-memory attach touches no filesystem, so nothing refuses it';
  });

  await check('\u2026but statementType rejects it before it runs', async () => {
    const attach = await connection.prepare(`ATTACH ':memory:' AS smuggled2`);
    const type = attach.statementType;
    attach.destroySync();
    if (type === StatementType.SELECT) throw new Error('ATTACH read as SELECT');
    return `${StatementType[type]} \u2260 SELECT \u2014 the allowlist is load-bearing, not belt-and-braces`;
  });

  await check('a legitimate SELECT still works once locked', async () => {
    const row = await one(connection, 'SELECT count(*) AS n FROM staged WHERE pr = 42');
    return `${row.n} rows — in-memory tables unaffected`;
  });

  await check('locked session still reads its materialised tables by name', async () => {
    const reader = await connection.runAndReadAll(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'staged' ORDER BY ordinal_position`,
    );
    return reader
      .getRowObjectsJson()
      .map((r) => `${r.column_name}:${r.data_type}`)
      .join(', ');
  });

  connection.closeSync();
  instance.closeSync();

  // ── 6. what each object store can and cannot ask DuckDB to do ──────────
  // The storage adapters are shaped by a handful of facts about this build of
  // DuckDB, and every one of them was found by running it rather than reading
  // about it. They need `httpfs`, which is fetched rather than statically
  // linked, so they live here and not in the suite — `bun run test` is not
  // allowed to need the network.
  const remote = await DuckDBInstance.create(':memory:');
  const remoteConnection = await remote.connect();

  await check('httpfs installs and loads', async () => {
    await remoteConnection.run('INSTALL httpfs');
    await remoteConnection.run('LOAD httpfs');
    const row = await one(
      remoteConnection,
      "SELECT count(*) AS n FROM duckdb_secret_types() WHERE type IN ('s3', 'gcs', 'http')",
    );
    return `${row.n}/3 of the secret types the object stores rely on exist`;
  });

  await check('an S3 secret is accepted', async () => {
    // `S3ObjectStore`. `CREATE SECRET` rather than `SET s3_access_key_id`,
    // because the setting form is instance-wide and this service runs
    // untrusted SQL on those instances.
    await remoteConnection.run(
      "CREATE OR REPLACE SECRET s3_probe (TYPE S3, KEY_ID 'k', SECRET 's', " +
        "REGION 'us-east-1', USE_SSL false, URL_STYLE 'path', ENDPOINT 'localhost:9000')",
    );
    return 'TYPE S3, with an endpoint and a URL style';
  });

  // The two findings `GcsObjectStore` exists because of. If either of these
  // ever starts passing, that adapter can lose its staging path and read
  // `gs://` like any other bucket — which would be a simplification worth
  // making, and this is what would notice.
  await check('a GCS secret still takes an HMAC key and nothing else', async () => {
    await refuses(
      remoteConnection,
      'gcs secret from the credential chain',
      'CREATE OR REPLACE SECRET gcs_probe (TYPE GCS, PROVIDER credential_chain)',
    );
    await remoteConnection.run(
      "CREATE OR REPLACE SECRET gcs_probe (TYPE GCS, KEY_ID 'k', SECRET 's')",
    );
    const row = await one(
      remoteConnection,
      "SELECT secret_string AS s FROM duckdb_secrets() WHERE name = 'gcs_probe'",
    );
    // No region, no URL style, and no way to hand it a service account: a
    // workload identity cannot reach gs://, which is why reads go over https.
    return String(row.s).replace(/^name=[^;]+;/, '');
  });

  await check('writing an https object is still not implemented', async () => {
    // The reason a GCS roll-up copies to local disk and uploads with the
    // client library instead of letting DuckDB `COPY … TO` the bucket.
    try {
      await remoteConnection.run(
        "COPY (SELECT 1 AS x) TO 'https://storage.googleapis.com/b/k.parquet' (FORMAT PARQUET)",
      );
      return 'it wrote — GcsObjectStore can drop its staging path';
    } catch (error) {
      return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
    }
  });

  // ── the read path a Google service account actually takes ──────────────
  // A local server standing in for the XML API: it serves a real Parquet file
  // and only to a request carrying the right bearer token. That is the whole
  // mechanism `GcsObjectStore.session()` depends on, and none of it involves
  // Google — so it can be proved here, on a laptop, with no bucket.
  const TOKEN = 'ya29.a-token-of-the-kind-a-metadata-server-hands-out';
  await remoteConnection.run(
    `COPY (SELECT range AS n FROM range(500)) TO '${join(scratch, 'served.parquet')}' (FORMAT PARQUET)`,
  );
  const served = readFileSync(join(scratch, 'served.parquet'));

  let presented: string | null = null;
  const origin = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    presented = 'the bearer token';
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : served.length - 1;
      response.writeHead(206, {
        'content-range': `bytes ${from}-${to}/${served.length}`,
        'content-length': String(to - from + 1),
        'accept-ranges': 'bytes',
      });
      response.end(served.subarray(from, to + 1));
      return;
    }
    response
      .writeHead(200, { 'content-length': String(served.length), 'accept-ranges': 'bytes' })
      .end(served);
  });
  await new Promise<void>((ready) => origin.listen(0, '127.0.0.1', ready));
  const port = (origin.address() as { port: number }).port;
  const object = `http://127.0.0.1:${port}/ingots/base/part-0000.parquet`;

  await check('an unauthenticated read of it is refused', async () => {
    await refuses(
      remoteConnection,
      'read with no token',
      `SELECT * FROM read_parquet('${object}')`,
    );
    return 'the stand-in is actually checking';
  });

  await check('a scoped bearer token authenticates a read', async () => {
    await remoteConnection.run(
      `CREATE OR REPLACE SECRET ingot_base (TYPE HTTP, BEARER_TOKEN '${TOKEN}', ` +
        `SCOPE 'http://127.0.0.1:${port}/ingots/')`,
    );
    const row = await one(remoteConnection, `SELECT count(*) AS n FROM read_parquet('${object}')`);
    return `${row.n} rows, and the server saw ${presented ?? 'nothing'}`;
  });

  await check('the token cannot be read back out of the session', async () => {
    // Load bearing. `duckdb_secrets()` is a table function, so a tenant's own
    // SELECT can call it and it passes every check the engine makes. If this
    // ever stops redacting, one tenant's query returns a credential that
    // reaches every other tenant's Parquet.
    const row = await one(
      remoteConnection,
      "SELECT secret_string AS s FROM duckdb_secrets() WHERE name = 'ingot_base'",
    );
    const rendered = String(row.s);
    if (rendered.includes(TOKEN)) throw new Error('the bearer token is stored in the clear');
    return rendered.slice(rendered.indexOf('bearer_token='));
  });

  origin.close();
  remoteConnection.closeSync();
  remote.closeSync();

  // ── verdict ───────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(
    `\n── ${checks.length - failed.length}/${checks.length} passed on ${runtime} ──\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(
      `\nfailed:\n${failed.map((c) => `  · ${c.name} — ${c.note}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stdout.write(`\nspike aborted: ${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  })
  .finally(() => rmSync(scratch, { recursive: true, force: true }));
