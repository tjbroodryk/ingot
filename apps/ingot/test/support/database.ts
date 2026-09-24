import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { oneQueryAtATime } from '../../src/database/database.module.js';
import * as schema from '../../src/database/schema.js';
import { PgUnitOfWork } from '../../src/shared/infrastructure/postgres/pg-unit-of-work.js';

/**
 * The suite's database — `ingot_test` in the compose Postgres, separate from
 * the development one because `truncate` runs between assertions. Override with
 * INGOT_TEST_DATABASE_URL.
 */
const CONNECTION =
  process.env.INGOT_TEST_DATABASE_URL ?? 'postgres://ingot:ingot@localhost:5432/ingot_test';

const MIGRATIONS = join(__dirname, '..', '..', 'drizzle');

/**
 * Tables the suite owns, truncated in one statement so declaration order does
 * not matter. A table missing here leaks state from one test into the next.
 */
const TABLES = [
  'account',
  'account_key',
  'ingot',
  'ingot_table',
  'overlay_row',
  'overlay_tombstone',
  'overlay_vector',
  'overlay_embed_queue',
  'overlay_receipt_queue',
  'receipt_delivery_queue',
];

export interface TestDatabase {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  /** Resets to an empty schema. Call in `beforeEach`. */
  truncate(): Promise<void>;
}

let opened: Promise<TestDatabase> | null = null;

/** Connects and brings the schema up to date, once per process. */
export function openDatabase(): Promise<TestDatabase> {
  opened ??= open();
  return opened;
}

export async function closeDatabase(): Promise<void> {
  const pending = opened;
  opened = null;
  if (!pending) return;
  await pending.then(({ pool }) => pool.end()).catch(() => {});
}

async function open(): Promise<TestDatabase> {
  const pool = new pg.Pool({ connectionString: CONNECTION, max: 8, connectionTimeoutMillis: 2000 });
  // As the service does, so a fan-out inside a transaction behaves the same here.
  pool.on('connect', oneQueryAtATime);

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(
      `No database at ${redact(CONNECTION)} — start it with \`bun run db:up\`` +
        `, or set INGOT_TEST_DATABASE_URL to point elsewhere. (${String(error)})`,
    );
  }

  await migrate(pool);

  // Anything building the real container from here on talks to this database,
  // not the one `.env` names. Set rather than defaulted: a `??=` would leave
  // `DatabaseModule` on the developer's database while `truncate()` emptied this.
  process.env.DATABASE_URL = CONNECTION;

  return {
    pool,
    db: drizzle(pool, { schema }),
    async truncate() {
      await pool.query(`TRUNCATE ${TABLES.join(', ')}`);
    },
  };
}

/** Applies every migration, every time; they are idempotent, so re-running is cheap. */
async function migrate(pool: pg.Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(join(MIGRATIONS, file), 'utf8'));
  }
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//');
}

/** A unit of work over the suite's connection, for hand-built repositories. */
export async function testUnitOfWork(): Promise<PgUnitOfWork> {
  const { db } = await openDatabase();
  return new PgUnitOfWork(db);
}
