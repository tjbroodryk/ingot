/**
 * Installs DuckDB extensions at build time so a session never fetches one.
 *
 * Run against the directory `INGOT_DUCKDB_EXTENSION_DIR` points at; the engine
 * sets `autoinstall_known_extensions = false`, so what is baked here is all a
 * session gets.
 */
import { DuckDBInstance } from '@duckdb/node-api';

/** Everything a session may `INSTALL`: `httpfs` for object stores, `fts` in every session. */
const EXTENSIONS = ['httpfs', 'fts'];

async function bake(): Promise<void> {
  // No argument: install into DuckDB's own `~/.duckdb`, where a session with no
  // `INGOT_DUCKDB_EXTENSION_DIR` looks.
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
