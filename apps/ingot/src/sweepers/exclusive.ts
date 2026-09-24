import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { DATABASE_URL, oneQueryAtATime } from '../database/database.module.js';

/** Class half of the two-argument advisory-lock key; the second half hashes the sweep name. */
const INGOT_SWEEPERS = 0x1470_7e00 | 0;

/**
 * Runs a named piece of work only on the process that can take its Postgres
 * advisory lock. A session lock on a dedicated connection, since a sweep spans
 * many transactions; `pg_try_advisory_lock` so a process that misses it skips
 * rather than waits.
 */
@Injectable()
export class ExclusiveWork implements OnApplicationShutdown {
  private readonly logger = new Logger('Sweepers');
  private client: pg.Client | null = null;
  private closed = false;

  constructor(@Inject(DATABASE_URL) private readonly url: string) {}

  /**
   * Runs `work` if this process can take the lock named by `key`; returns
   * whether it did. `false` means another process holds it, not an error.
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
      // Swallow unlock failures: a dead session drops its locks anyway, and
      // throwing here would mask the caller's real error.
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [INGOT_SWEEPERS, hash32(key)])
        .catch(() => undefined);
    }
  }

  /** The lock connection, opened on first use and reopened if it has dropped. */
  private async connect(): Promise<pg.Client> {
    if (this.client) return this.client;

    const client = new pg.Client({ connectionString: this.url });
    // Serialize queries on this long-lived connection, as the pool does its own.
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
    // Ending the session drops every advisory lock it held.
    await client?.end().catch(() => undefined);
  }
}

/** Stable signed 32-bit hash (FNV-1a) for a name, sized to the `int4` the lock takes. */
export function hash32(value: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash | 0;
}
