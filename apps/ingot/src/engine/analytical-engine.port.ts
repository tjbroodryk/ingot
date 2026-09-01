import type { ColumnType, FtsConfig } from '@ingot/shared/ingot-v1';

/** A vector attached to a row, in either tier. */
export interface RowVector {
  readonly rowId: string;
  readonly column: string;
  readonly vector: readonly number[];
}

/**
 * Everything needed to reconstruct one logical table inside a session: its
 * declared shape, its base Parquet, its overlay, and what has been forgotten.
 */
export interface MaterialisableTable {
  readonly name: string;
  readonly columns: readonly { name: string; type: ColumnType }[];
  /** Object-store URIs, already resolved. Empty before the first roll-up. */
  readonly baseFiles: readonly string[];
  readonly vectorFiles: readonly string[];
  /** Rows accepted but not yet rolled up. Keys are column names. */
  readonly overlayRows: readonly Readonly<Record<string, unknown>>[];
  readonly overlayVectors: readonly RowVector[];
  readonly tombstones: readonly string[];
  /** Columns carrying an embedding, and the width of it. */
  readonly embedded: readonly { column: string; dimensions: number }[];
  /**
   * How this table is indexed for keyword search.
   *
   * Carried into the session rather than applied to the stored data, because a
   * full text index is not a thing Parquet holds: it is built inside the
   * session, from these settings, over the rows both tiers just produced. That
   * is what lets the settings change without rewriting anything.
   */
  readonly fts: FtsConfig;
}

export interface QueryRequest {
  readonly tables: readonly MaterialisableTable[];
  readonly sql: string;
  /** Bound as `$q` so a caller's own SQL can rank by similarity. */
  readonly queryVector?: readonly number[];
  readonly rowCap: number;
  readonly timeoutMs: number;
}

export interface QueryOutcome {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface CompactionRequest {
  readonly table: MaterialisableTable;
  /** Where the new generation goes. Ours, never a caller's. */
  readonly baseTarget: string;
  readonly vectorTarget: string;
}

export interface CompactionOutcome {
  readonly rows: number;
  readonly vectors: number;
}

/**
 * DuckDB, behind a seam.
 *
 * A port not because a second implementation is planned, but because every
 * call into the engine goes through one interface — which is what made the
 * Phase 0 spike's fallback plan (a Node sidecar owning DuckDB, spoken to over
 * a socket) a change of adapter rather than a redesign. The spike said the
 * fallback is not needed; the seam is cheap enough to keep anyway.
 */
export interface AnalyticalEngine {
  /** Runs a caller's SQL against a sandboxed session. */
  run(request: QueryRequest): Promise<QueryOutcome>;

  /**
   * Resolves a predicate to the row ids it matches.
   *
   * Same sandbox as `run`. Deletes name rows rather than storing predicates,
   * so this is what turns `where` into a finite set of tombstones.
   */
  resolveRows(request: {
    table: MaterialisableTable;
    where: string;
    cap: number;
    timeoutMs: number;
  }): Promise<{ rowIds: readonly string[]; truncated: boolean }>;

  /**
   * Writes base ∪ overlay out as a new Parquet generation.
   *
   * Not sandboxed: the SQL is ours and it has to write. That asymmetry is why
   * this is a separate method rather than a flag on `run` — a flag is
   * something a future caller can pass.
   */
  compact(request: CompactionRequest): Promise<CompactionOutcome>;
}

export const ANALYTICAL_ENGINE = Symbol('AnalyticalEngine');
