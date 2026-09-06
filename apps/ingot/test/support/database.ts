import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { oneQueryAtATime } from '../../src/database/database.module.js';
import * as schema from '../../src/database/schema.js';
import { PgUnitOfWork } from '../../src/shared/infrastructure/postgres/pg-unit-of-work.js';

/**
 * The suite's database — `ingot_test` in the compose Postgres.
 *
 * Separate from the development database on purpose: `truncate` runs between
 * assertions, and pointing that at the database you also keep local state in
 * is how a test run quietly deletes an afternoon's work. Override with
 * INGOT_TEST_DATABASE_URL to point somewhere else.
 */
const CONNECTION =
  process.env.INGOT_TEST_DATABASE_URL ?? 'postgres://ingot:ingot@localhost:5432/ingot_test';

const MIGRATIONS = join(__dirname, '..', '..', 'drizzle');

/**
 * Tables the suite owns.
 *
 * Truncated in one statement, which makes the foreign key from `account_key`
 * to `account` a non-issue: `TRUNCATE a, b` is legal where `TRUNCATE a` alone
 * would be refused for still being referenced. Declaration order therefore
 * does not matter — but completeness does. A table missing from this list is
 * state leaking from one test into the next.
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
  // As the service does, so a fan-out inside a transaction behaves here the
  // way it behaves in production rather than on pg's deprecated queue.
  pool.on('connect', oneQueryAtATime);

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    // Actionable rather than a stack trace about ECONNREFUSED: the fix is one
    // command, and the message may as well say which.
    throw new Error(
      `No database at ${redact(CONNECTION)} — start it with \`bun run db:up\`` +
        `, or set INGOT_TEST_DATABASE_URL to point elsewhere. (${String(error)})`,
    );
  }

  await migrate(pool);

  /**
   * Anything that builds the real container from here on talks to this
   * database, and not to whichever one `.env` names.
   *
   * Set rather than defaulted, and that is the whole point: `DATABASE_URL` is
   * in every developer's `.env` pointing at the database they keep local state
   * in, so a `??=` here would leave `DatabaseModule` connected to it while
   * `truncate()` emptied a different one. That was survivable while compiling
   * `AppModule` only read; it stopped being survivable when sealed mode gave
   * the graph an `OnApplicationBootstrap` that writes an account.
   */
  process.env.DATABASE_URL = CONNECTION;

  return {
    pool,
    db: drizzle(pool, { schema }),
    async truncate() {
      await pool.query(`TRUNCATE ${TABLES.join(', ')}`);
    },
  };
}

/**
 * Applies every migration, every time.
 *
 * They are written to be idempotent, so re-running them is cheap and a newly
 * added migration reaches the test database without anyone remembering to
 * rebuild the container.
 */
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
