import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { DATABASE_URL, oneQueryAtATime } from '../database/database.module.js';

/**
 * Which application the lock keys belong to.
 *
 * A Postgres advisory lock key is global to the database, so the two-argument
 * form is used to namespace ours: this constant is the class, and the second
 * half is a hash of the sweep's name. Anything else taking advisory locks in
 * the same database picks its own class and the two cannot collide by
 * accident.
 */
const INGOT_SWEEPERS = 0x1470_7e00 | 0;

/**
 * One replica at a time, per named piece of work.
 *
 * This is the guarantee the Restate cron chain used to give and the only one
 * that was load bearing. Two replicas rolling the same table up would both
 * compute `generation + 1`, write to the same keys and both flip the manifest;
 * `CompactTable` has no guard of its own, and this is where it comes from.
 *
 * A **session** lock rather than a transaction one, because a sweep is not a
 * transaction — it dispatches commands that open their own, and holding one
 * open across all of them would tie up a pool connection and invite a deadlock
 * with the work it is protecting.
 *
 * So the lock lives on a connection of this class's own, opened from
 * `DATABASE_URL` rather than taken from the pool. That is the same reasoning
 * `DatabaseModule` gives for exposing the URL at all, and the same reasoning
 * behind never handing a `LISTEN` connection back: a session lock belongs to a
 * session, and a pooled client is not one you keep.
 *
 * `pg_try_advisory_lock` and not `pg_advisory_lock`: a pod that cannot get the
 * lock has nothing to wait for. The holder is doing the work, and queueing
 * would only produce a second pass the moment the first finished.
 */
@Injectable()
export class ExclusiveWork implements OnApplicationShutdown {
  private readonly logger = new Logger('Sweepers');
  private client: pg.Client | null = null;
  private closed = false;

  constructor(@Inject(DATABASE_URL) private readonly url: string) {}

  /**
   * Runs `work` if this process can take the lock named by `key`, and reports
   * whether it did.
   *
   * `false` is an ordinary answer and not an error: it means another replica is
   * already on it.
   */
  async attempt(key: string, work: () => Promise<void>): Promise<boolean> {
    const client = await this.connect();
    const { rows } = await client.query<{ taken: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS taken',
      [INGOT_SWEEPERS, hash32(key)],
    );

    if (!rows[0]?.taken) return false;

    try {
      await work();
      return true;
    } finally {
      /*
       * Released even when the work threw, and the failure to release is
       * swallowed on purpose: the only way `pg_advisory_unlock` fails here is a
       * connection that has already gone, and a lock on a dead session is
       * released by Postgres anyway. Throwing would replace the caller's real
       * error with a bookkeeping one.
       */
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [INGOT_SWEEPERS, hash32(key)])
        .catch(() => undefined);
    }
  }

  /**
   * The connection, opened on first use and kept.
   *
   * Reconnected if it has dropped, because a lock taken on a session that has
   * since died is not held — so the next attempt should be free to take it
   * again rather than failing forever against a closed client.
   */
  private async connect(): Promise<pg.Client> {
    if (this.client) return this.client;

    const client = new pg.Client({ connectionString: this.url });
    // The same serialising the pool applies to its own connections. Nothing
    // here issues overlapping queries today, but this client outlives every
    // caller and the rule should not depend on that staying true.
    client.on('error', (error) => {
      this.logger.warn(`The lock connection dropped: ${error.message}. It will be reopened.`);
      this.client = null;
    });

    await client.connect();
    oneQueryAtATime(client as unknown as pg.PoolClient);
    if (this.closed) {
      await client.end().catch(() => undefined);
      throw new Error('The scheduler is shutting down');
    }

    this.client = client;
    return client;
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    // Ending the session drops every advisory lock it held, which is exactly
    // what a pod going away should do — the next replica to tick takes over
    // rather than waiting out a lease.
    await client?.end().catch(() => undefined);
  }
}

/**
 * A stable 32-bit key for a name.
 *
 * FNV-1a, and it does not have to be a good hash — it has to be the same on
 * every replica and fit the `int4` the two-argument lock takes. Signed, because
 * that is the range Postgres accepts.
 */
export function hash32(value: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash | 0;
}
