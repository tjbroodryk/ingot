import type { MappedRow } from '../../domain/row-mapping.vo.js';

/** One overlay row as it comes back out, with the sequence it was written at. */
export interface OverlayRow {
  readonly rowId: string;
  readonly seq: bigint;
  readonly payload: MappedRow;
}

/** A table with enough in its overlay to be worth rolling up. */
export interface OverlayDepth {
  readonly tableId: string;
  readonly rows: number;
  readonly tombstones: number;
  readonly oldest: Date;
}

export interface PendingEmbedding {
  readonly tableId: string;
  readonly rowId: string;
  readonly column: string;
  readonly text: string;
}

/** One `/add` waiting to be described. Enough to prompt a model, and no more. */
export interface PendingReceipt {
  /** The batch of the `/add` this describes. Its identity, here and in SQL. */
  readonly batch: string;
  /** The caller's own handle for the result, or null if they gave none. */
  readonly externalId: string | null;
  readonly ingotId: string;
  /** The table that write went into — the source, never `ingot_receipts` itself. */
  readonly tableId: string;
  readonly sourceTable: string;
  /** The caller's tool result, as it arrived. */
  readonly body: unknown;
  readonly rows: number;
  /** Including this one — the count is incremented by the claim itself. */
  readonly attempts: number;
}

/**
 * Re-exported so the adapters that claim work keep importing it from the port
 * they implement. It lives in `shared/claim-lease.ts` because it is no longer
 * only this queue's business: the settings modules hold their timeouts to it
 * at boot, and neither of them should be reaching into a context to do that.
 */
export { CLAIM_LEASE_MS } from '../../../../shared/claim-lease.js';

/**
 * The hot half of the store: rows that have been accepted but not yet rolled
 * up into Parquet.
 *
 * A port rather than a repository because the overlay is not an aggregate —
 * it holds no invariants of its own and nothing decides anything from its
 * state. It is a buffer with a sequence number, and the sequence number is the
 * only part that matters: compaction reads to a watermark and deletes to the
 * same watermark, which is what makes a roll-up safe against writes arriving
 * while it runs.
 */
export interface OverlayStore {
  append(input: {
    ingotId: string;
    tableId: string;
    rows: readonly MappedRow[];
    embeddable: readonly string[];
  }): Promise<number>;

  /** Every row of a table, up to and including `throughSeq` if given. */
  read(tableId: string, throughSeq?: bigint): Promise<readonly OverlayRow[]>;

  /** The highest sequence currently in the table's overlay, or null if empty. */
  watermark(tableId: string): Promise<bigint | null>;

  count(tableId: string): Promise<number>;

  /** Row ids forgotten by a `/delete`, which every read must filter out. */
  tombstones(tableId: string): Promise<readonly string[]>;

  countTombstones(tableId: string): Promise<number>;

  forget(tableId: string, rowIds: readonly string[], at: Date): Promise<void>;

  /**
   * Drops overlay rows consumed by a roll-up, and retires the tombstones that
   * roll-up made redundant.
   *
   * `throughSeq` is null when a table was compacted purely to apply deletes —
   * there were no rows to fold in, only rows to leave out. Nothing is drained
   * in that case, but the tombstones are still spent.
   */
  drain(tableId: string, throughSeq: bigint | null): Promise<void>;

  /** Everything belonging to a table, for a drop. */
  purgeTable(tableId: string): Promise<void>;
  purgeIngot(ingotId: string): Promise<void>;

  tablesWorthCompacting(minimumRows: number, limit: number): Promise<readonly OverlayDepth[]>;

  // ── vectors ───────────────────────────────────────────────────────────
  /**
   * Takes up to `limit` texts nobody else is embedding, and leases them.
   *
   * The lease is what a row lock would have been if the embedding happened in
   * this transaction. It does not: a hosted model is an HTTP round trip, and
   * the connection is given back before it is made. Without the lease a second
   * replica claims the same texts and buys the same vectors twice, and a batch
   * slower than the sweep interval is re-claimed while still in flight.
   */
  claimPending(limit: number, now: Date): Promise<readonly PendingEmbedding[]>;

  /**
   * Puts a claim back without a vector, so the next tick may try again.
   *
   * A model that is down is a model that will be up. The alternative is
   * waiting out the lease for work that is already known to have failed.
   */
  releasePending(entries: readonly PendingEmbedding[]): Promise<void>;

  saveVectors(
    vectors: readonly {
      tableId: string;
      rowId: string;
      column: string;
      vector: readonly number[];
    }[],
    model: string,
  ): Promise<void>;
  readVectors(
    tableId: string,
    column: string,
  ): Promise<readonly { rowId: string; vector: readonly number[] }[]>;
  pendingCount(): Promise<number>;
  totalRows(): Promise<number>;

  // ── receipts ───────────────────────────────────────────────────────────
  /** Queues the work `receipt: "summary"` asked for. One row per `/add`. */
  queueReceipt(input: {
    /** The caller's own handle for this result, or null if they gave none. */
    externalId: string | null;
    batch: string;
    ingotId: string;
    tableId: string;
    sourceTable: string;
    body: unknown;
    rows: number;
    queuedAt: Date;
  }): Promise<void>;

  /**
   * Takes the oldest receipt nobody else is working on, and leases it.
   *
   * One at a time, because the next step is a model call and the caller wants
   * its transaction back before making it. The lease is what stops a second
   * worker taking the same one while it is in flight, and it expires so that a
   * worker which died mid-call does not strand the row.
   *
   * **The claim is what counts the attempt.** A worker killed by the very
   * result it is describing never reaches a failure handler, so a counter
   * written there would never move and a poison body would be retried for
   * ever. Paying up front makes every claim cost one, whatever happens next.
   *
   * Null when the queue is empty, when everything left is leased, or when
   * everything left has failed too often — all the same answer to a sweeper.
   */
  claimReceipt(maxAttempts: number, now: Date): Promise<PendingReceipt | null>;

  /** Done: the receipt row is written, so the work leaves the queue. */
  completeReceipt(batch: string): Promise<void>;

  /**
   * Not done: keep the reason, and hand the row back before its lease is up.
   *
   * The attempt was already counted by the claim, so this only explains and
   * releases. Releasing matters: a model that failed a second ago is worth
   * asking again on the next tick, not in five minutes when the lease lapses.
   */
  failReceipt(batch: string, reason: string): Promise<void>;

  /** Queued and still winnable. The gauge that says the summariser is behind. */
  receiptsPending(maxAttempts: number): Promise<number>;

  /** Queued and out of attempts. Not retried; kept so somebody can look. */
  receiptsAbandoned(maxAttempts: number): Promise<number>;
}

export const OVERLAY_STORE = Symbol('OverlayStore');
