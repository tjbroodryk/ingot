import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * What a repository actually needs: the query methods, satisfied by both the
 * pool handle and a transaction. Typed as the intersection so a repository
 * cannot accidentally call `transaction` on something that is already one.
 */
export type Queryable = Pick<
  Database,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'delete' | 'execute'
>;

/** The query handle every repository and read model resolves. */
export const DATABASE = Symbol('Database');

/**
 * The pool itself, exposed separately because a few things need a raw
 * connection rather than a query builder — `LISTEN` most of all, which holds a
 * session for its lifetime and must never be handed back to the pool.
 */
export const DATABASE_POOL = Symbol('DatabasePool');

/**
 * The connection string, exposed so a component that opens its own dedicated
 * connection does not have to re-derive it from config.
 */
export const DATABASE_URL = Symbol('DatabaseUrl');

/**
 * pg's `query`, as every overload of it is shaped once the arguments are in
 * hand. Only used to hold onto the original while it is being wrapped.
 */
type IssueQuery = (...args: readonly unknown[]) => unknown;

/**
 * One connection, one question at a time.
 *
 * `pg` has always queued a query issued while its connection was busy, and
 * that queue is what has been carrying every concurrent read inside a
 * transaction. A `Promise.all` over one table's overlay and its tombstones is
 * two calls on the single client `BEGIN` reserved, and pg quietly ran them one
 * after another. It now warns that it is doing so, and drops the queue in
 * pg@9 — which turns a compaction's reads into a runtime failure.
 *
 * So the queue moves here. Nothing about the timing changes, because those
 * queries were never running at the same time; what changes is that the
 * serialising is ours and survives the upgrade. The fan-outs stay worth
 * writing either way — outside a transaction `queryable` is the pool, and
 * each read gets a connection of its own.
 *
 * Only the promise form is chained. A callback, or a submittable like a
 * cursor, answers through its own channel and hands back nothing to chain on;
 * pg's own queue still covers those, and nothing in this service uses them.
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
    // Caught on the chain rather than on the caller's copy, which still
    // rejects: one failed query is not a reason for the next one never to be
    // sent, and an unhandled rejection here would be ours rather than theirs.
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

/**
 * Postgres, once, for the whole process.
 *
 * Global because persistence is kernel infrastructure in the same way the
 * clock is: a bounded context should declare the repository it needs, not
 * re-import the plumbing underneath it.
 *
 * The pool is sized for a pod, not for the cluster. Postgres' connection limit
 * is a cluster-wide budget, and `max` multiplies by replica count — which is
 * the same arithmetic that makes a `LISTEN`-per-socket design untenable and
 * why realtime fan-out shares one connection per pod instead.
 */
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
        // Once per physical connection, which is the only moment a client is
        // handed over before anyone has queried it.
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

  /**
   * Pods are cattle: Kubernetes sends SIGTERM and starts counting. Draining the
   * pool here is what turns a rolling deploy into a clean handover instead of a
   * burst of connection-reset errors on the way out.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
