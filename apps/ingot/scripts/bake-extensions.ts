/**
 * Put the extensions in the image, so a cold container never fetches one.
 *
 * DuckDB ships `parquet` statically linked and these from
 * extensions.duckdb.org. Left alone, the first query a fresh pod serves goes
 * out to the internet for one — which on a network that does not allow that is
 * a first query that fails, with an error naming an extension rather than the
 * egress rule that actually stopped it.
 *
 * Run at build time against the directory `INGOT_DUCKDB_EXTENSION_DIR` will
 * point at. The engine sets `autoinstall_known_extensions = false`, so what is
 * here at build time is all a session will ever have.
 */
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Everything a session may `INSTALL`.
 *
 * `httpfs` is installed by every bucket-backed object store; `fts` by every
 * session there is, since `DuckDbEngine.configure` loads it whether or not the
 * query turns out to search anything. Keep in step with both.
 */
const EXTENSIONS = ['httpfs', 'fts'];

async function bake(): Promise<void> {
  // No argument is the developer's case: install into DuckDB's own directory,
  // `~/.duckdb`, which is where a session with no `INGOT_DUCKDB_EXTENSION_DIR`
  // looks. That is what `bun run extensions` does, and it is what makes the
  // test suite runnable offline afterwards — the engine loads `fts` in every
  // session, so a machine that has never fetched one cannot run a query.
  const directory = process.argv[2];

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  if (directory) await connection.run(`SET extension_directory = '${directory}'`);
  for (const extension of EXTENSIONS) {
    await connection.run(`INSTALL ${extension}`);
    await connection.run(`LOAD ${extension}`);
  }

  const installed = await connection.runAndReadAll(
    'SELECT extension_name, installed, install_mode FROM duckdb_extensions() ' +
      `WHERE extension_name IN (${EXTENSIONS.map((name) => `'${name}'`).join(', ')})`,
  );
  process.stdout.write(
    `${JSON.stringify(installed.getRowObjectsJson())} → ${directory ?? "DuckDB's own directory"}\n`,
  );

  instance.closeSync();
}

void bake();
