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
   * How this table is indexed for keyword search. Built inside the session from
   * these settings, not stored, so changing them rewrites nothing.
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

/** DuckDB, behind a port so every call into the engine goes through one interface. */
export interface AnalyticalEngine {
  /** Runs a caller's SQL against a sandboxed session. */
  run(request: QueryRequest): Promise<QueryOutcome>;

  /**
   * Resolves a predicate to the row ids it matches, in the same sandbox as
   * `run`; turns a `where` into a finite set of tombstones.
   */
  resolveRows(request: {
    table: MaterialisableTable;
    where: string;
    cap: number;
    timeoutMs: number;
  }): Promise<{ rowIds: readonly string[]; truncated: boolean }>;

  /**
   * Writes base ∪ overlay out as a new Parquet generation. Not sandboxed, since
   * the SQL is ours and has to write.
   */
  compact(request: CompactionRequest): Promise<CompactionOutcome>;
}

export const ANALYTICAL_ENGINE = Symbol('AnalyticalEngine');
