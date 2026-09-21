import { Logger } from '@nestjs/common';

/** What a warm session has to be able to do once nobody is going to use it. */
export interface Closeable {
  close(): void;
}

/**
 * DuckDB instances opened and configured ahead of the query that will use them.
 *
 * An instance cannot be reused — `lock_configuration` does not come undone —
 * but nothing stops one being *prepared* early. Creating it, applying the
 * limits and loading `fts` is most of what a small query costs, and none of it
 * depends on the query, so it happens here, off the request path, and a query
 * takes one that is ready.
 *
 * Each one is still single-use: taken, used, closed. Taking one starts opening
 * its replacement. An empty pool is not an error — the caller opens its own,
 * which is exactly what happened before there was a pool, and `size` 0 is that
 * behaviour on purpose.
 *
 * A failed open is logged and not retried until the next take, so a broken
 * extension directory is one warning per query rather than a loop.
 */
export class WarmSessions<T extends Closeable> {
  private readonly logger = new Logger(WarmSessions.name);
  private readonly ready: T[] = [];
  private opening = 0;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly open: () => Promise<T>,
  ) {}

  start(): void {
    this.refill();
  }

  take(): T | undefined {
    const session = this.ready.pop();
    this.refill();
    return session;
  }

  close(): void {
    this.closed = true;
    for (const session of this.ready.splice(0)) session.close();
  }

  /** How many are ready now. For tests and nothing else. */
  get available(): number {
    return this.ready.length;
  }

  private refill(): void {
    while (!this.closed && this.ready.length + this.opening < this.size) {
      this.opening += 1;
      this.open()
        .then((session) => {
          // Shut down while this one was opening: nobody will take it.
          if (this.closed) session.close();
          else this.ready.push(session);
        })
        .catch((error: unknown) => {
          this.logger.warn(`Could not open a warm query session: ${String(error)}`);
        })
        .finally(() => {
          this.opening -= 1;
        });
    }
  }
}
