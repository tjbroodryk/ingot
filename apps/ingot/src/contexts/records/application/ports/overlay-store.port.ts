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

/** Re-exported so claim adapters import it from the port they implement. */
export { CLAIM_LEASE_MS } from '../../../../shared/claim-lease.js';

/**
 * The hot half of the store: rows accepted but not yet rolled up into Parquet. A
 * port, not a repository — the overlay holds no invariants, only a sequence
 * number that compaction reads and deletes to.
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
   * Drops overlay rows consumed by a roll-up and retires the tombstones it made
   * redundant. `throughSeq` is null when a table was compacted only to apply
   * deletes: nothing is drained, but the tombstones are still spent.
   */
  drain(tableId: string, throughSeq: bigint | null): Promise<void>;

  /** Everything belonging to a table, for a drop. */
  purgeTable(tableId: string): Promise<void>;
  purgeIngot(ingotId: string): Promise<void>;

  tablesWorthCompacting(minimumRows: number, limit: number): Promise<readonly OverlayDepth[]>;

  // ── vectors ───────────────────────────────────────────────────────────
  /**
   * Takes up to `limit` texts nobody else is embedding, and leases them. The
   * lease stands in for a row lock, since the connection is given back before the
   * embedder call; without it a second worker buys the same vectors twice.
   */
  claimPending(limit: number, now: Date): Promise<readonly PendingEmbedding[]>;

  /** Puts a claim back without a vector, so the next tick may try again. */
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
   * Takes the oldest receipt nobody else is working on, and leases it. The lease
   * expires if a worker dies mid-call; the claim counts the attempt, so a poison
   * body is not retried for ever. Null when nothing is claimable.
   */
  claimReceipt(maxAttempts: number, now: Date): Promise<PendingReceipt | null>;

  /** Done: the receipt row is written, so the work leaves the queue. */
  completeReceipt(batch: string): Promise<void>;

  /**
   * Not done: keep the reason, and hand the row back before its lease is up. The
   * claim already counted the attempt, so this only explains and releases.
   */
  failReceipt(batch: string, reason: string): Promise<void>;

  /** Queued and still winnable. The gauge that says the summariser is behind. */
  receiptsPending(maxAttempts: number): Promise<number>;

  /** Queued and out of attempts. Not retried; kept for inspection. */
  receiptsAbandoned(maxAttempts: number): Promise<number>;
}

export const OVERLAY_STORE = Symbol('OverlayStore');
