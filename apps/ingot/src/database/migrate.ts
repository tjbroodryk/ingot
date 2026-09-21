import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadSection } from '../config/env.js';
import { section, textOr } from '../config/vars.js';
import { databaseEnv } from './database-settings.js';

/**
 * Bring a database up to schema, from outside the service.
 *
 * `docker/migrate.sh` does this for a laptop by running `psql` inside the
 * Postgres container, which is available exactly once: when Postgres is
 * something you started yourself. A deployment's database is somebody else's —
 * a managed instance, reachable over the network and with no shell to exec
 * into — so the migration has to be something the image itself can run.
 *
 *   kubectl run … --image=ingot --command -- bun dist/database/migrate.js
 *
 * Every migration is written to be idempotent (`CREATE TABLE IF NOT EXISTS`,
 * `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`), so this applies all of
 * them every time rather than keeping a ledger of which have run. That is the
 * property that makes it safe as a Kubernetes `Job` that may be retried, and
 * safe to run against a database that is already current.
 *
 * Each file goes in its own transaction: a migration that fails leaves the
 * ones before it applied and says which one stopped, rather than rolling back
 * an hour of work on a large table.
 */
const migrateEnv = section(
  {
    // `dist/database/` → the `drizzle/` beside `dist/`, which is where the
    // image puts them. Overridable because a test and a Job disagree about cwd.
    INGOT_MIGRATIONS_DIR: textOr(join(__dirname, '..', '..', 'drizzle')),
  },
  (vars) => resolve(vars.INGOT_MIGRATIONS_DIR),
);

async function migrate(): Promise<void> {
  // Only what a migration needs: a Job has no reason to carry the service's
  // auth or storage settings, so this does not load the whole `Env`.
  const { url } = loadSection(databaseEnv, process.env);
  const directory = loadSection(migrateEnv, process.env);

  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${directory}`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  process.stdout.write(`Applying ${files.length} migrations from ${directory}\n`);

  try {
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        process.stdout.write(`  applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    await client.end();
  }

  process.stdout.write('Schema is up to date.\n');
}

migrate().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
