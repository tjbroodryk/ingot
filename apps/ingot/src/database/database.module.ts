import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The query methods a repository needs, satisfied by both the pool and a
 * transaction. Typed so a repository cannot call `transaction` on a transaction.
 */
export type Queryable = Pick<
  Database,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'delete' | 'execute'
>;

/** The query handle every repository and read model resolves. */
export const DATABASE = Symbol('Database');

/** The raw pool, for components that need a connection rather than a query builder (e.g. `LISTEN`). */
export const DATABASE_POOL = Symbol('DatabasePool');

/** The connection string, for components that open their own connection. */
export const DATABASE_URL = Symbol('DatabaseUrl');

/** pg's `query`, as its overloads collapse once the arguments are in hand. */
type IssueQuery = (...args: readonly unknown[]) => unknown;

/**
 * Serialise queries on a single client, running them one at a time.
 *
 * pg's own queue warns and is dropped in pg@9, so the serialising moves here.
 * Only the promise form is chained; callbacks and cursors answer their own way.
 */
export function oneQueryAtATime(client: pg.PoolClient): void {
  const issue = client.query.bind(client) as unknown as IssueQuery;
  let inFlight: Promise<unknown> = Promise.resolve();

  const serialised: IssueQuery = (...args) => {
    const [config, values, callback] = args;
    const submittable = typeof (config as { submit?: unknown } | null)?.submit === 'function';
    if (submittable || typeof values === 'function' || typeof callback === 'function') {
      return issue(...args);
    }

    const answered = inFlight.then(() => issue(...args));
    // Caught on the chain so one failure doesn't stall the next; the caller's
    // copy still rejects.
    inFlight = answered.catch(() => undefined);
    return answered;
  };

  client.query = serialised as unknown as typeof client.query;
}

function connectionString(config: ConfigService): string {
  const url = config.get<string>('DATABASE_URL');
  if (!url) {
    throw new Error('DATABASE_URL is not set — Ingot cannot start without its database');
  }
  return url;
}

/** Postgres, once, for the whole process. Global, like the clock. */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_URL,
      inject: [ConfigService],
      useFactory: connectionString,
    },
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new pg.Pool({
          connectionString: connectionString(config),
          max: config.get<number>('DATABASE_POOL_MAX') ?? 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        // Once per physical connection, before anyone has queried it.
        pool.on('connect', oneQueryAtATime);
        return pool;
      },
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: pg.Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DATABASE, DATABASE_POOL, DATABASE_URL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {}

  /** Drain the pool on shutdown for a clean handover. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
