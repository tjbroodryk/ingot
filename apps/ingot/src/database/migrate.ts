import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { errorMessage } from '../shared/error-message.js';

/**
 * Bring a database up to schema from outside the service.
 *
 * Applies every migration each run — they are idempotent — rather than keeping
 * a ledger. Each file runs in its own transaction, so a failure leaves the
 * earlier ones applied and names the one that stopped.
 */
async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — there is nothing to migrate');
  }

  // `dist/database/` → the `drizzle/` beside `dist/`. Overridable via env.
  const directory = resolve(
    process.env.INGOT_MIGRATIONS_DIR ?? join(__dirname, '..', '..', 'drizzle'),
  );

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
        throw new Error(`${file} failed: ${errorMessage(error)}`);
      }
    }
  } finally {
    await client.end();
  }

  process.stdout.write('Schema is up to date.\n');
}

migrate().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
