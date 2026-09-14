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
 * How long this connection may sit silent before TCP starts asking whether the
 * other end is still there.
 *
 * It is idle almost all the time by design — the lock is taken here and the
 * sweep itself runs on the pool — so without keepalives a pod partitioned from
 * Postgres notices nothing, and neither does Postgres: the backend stays up,
 * and with it every advisory lock that pod was holding. At Linux defaults that
 * is a couple of hours during which no other replica can sweep.
 *
 * This is the near side of that. It makes *us* notice, so the error handler
 * below reconnects and the next turn takes the lock again. Making the far side
 * notice is `tcp_keepalives_idle` on the server, which is Postgres' setting
 * rather than ours.
 */
const KEEPALIVE_AFTER_MS = 30_000;

/** How the lock connection introduces itself in `pg_stat_activity`. */
const APPLICATION_NAME = 'ingot-sweepers';

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
  /**
   * The connection as a promise rather than a client, which is the whole of
   * what keeps there being one of it.
   *
   * Every sweeper's first turn is booked at a delay of zero, so all six fire in
   * the same timer phase and all six ask for this connection before any of them
   * has one. Against a `client | null` field they each read `null`, each open a
   * socket, and the last to finish wins the field — six connections where the
   * pool is sized at ten, five of them reachable by nothing and so never ended,
   * holding the event loop open through a shutdown that was supposed to be
   * quick. Memoising the promise means the five that lost the race await the
   * same open as the one that won it.
   */
  private connecting: Promise<pg.Client> | null = null;
  /**
   * The same client once it is up, so the error handler can tell whether the
   * drop it is being told about is the connection still in use or one already
   * replaced.
   */
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
  private connect(): Promise<pg.Client> {
    if (this.closed) return Promise.reject(new Error('The scheduler is shutting down'));

    this.connecting ??= this.open().catch((error: unknown) => {
      // A failed open is not kept. Remembering it would leave every sweep for
      // the life of the process awaiting the one rejected promise from the
      // moment Postgres happened to be restarting.
      this.connecting = null;
      throw error;
    });

    return this.connecting;
  }

  private async open(): Promise<pg.Client> {
    const client = new pg.Client({
      connectionString: this.url,
      application_name: APPLICATION_NAME,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_AFTER_MS,
    });

    client.on('error', (error) => {
      this.logger.warn(`The lock connection dropped: ${error.message}. It will be reopened.`);
      this.forget(client);
    });

    await client.connect();
    // The same serialising the pool applies to its own connections. Nothing
    // here issues overlapping queries today, but this client outlives every
    // caller and the rule should not depend on that staying true.
    oneQueryAtATime(client as unknown as pg.PoolClient);
    if (this.closed) {
      await client.end().catch(() => undefined);
      throw new Error('The scheduler is shutting down');
    }

    this.client = client;
    return client;
  }

  /**
   * Drops the memo, but only when the connection being reported dead is the one
   * it is holding — a late error from a client already replaced would otherwise
   * throw away a perfectly good connection somebody is mid-sweep on.
   */
  private forget(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.connecting = null;
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    this.connecting = null;
    this.client = null;
    /*
     * The memo rather than the field, so a connection still being opened when
     * the pod was told to go away is closed too. One left to finish into
     * nothing keeps its socket — and with it the event loop — open until
     * Kubernetes runs out of grace and sends SIGKILL.
     *
     * Ending the session drops every advisory lock it held, which is exactly
     * what a pod going away should do: the next replica to tick takes over
     * rather than waiting out a lease.
     */
    await pending?.then((client) => client.end()).catch(() => undefined);
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
