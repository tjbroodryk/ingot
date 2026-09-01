/**
 * The base tier: Parquet objects, addressed by key.
 *
 * The port deliberately does not move bytes on the read path. DuckDB reads
 * Parquet far better than we would — it pushes projections and filters down
 * into the file and streams the result — so the useful thing to hand it is a
 * *string it can open*, not a buffer we fetched first. That is what `uri` is.
 *
 * `session` is the price of that: reaching a remote object needs a credential
 * installed in the connection, and only the adapter knows what it should say.
 * Those statements run while external access is still enabled, before the
 * query sandbox is locked down — which is the whole reason the session recipe
 * is ordered the way it is. It is asynchronous because a credential may have
 * to be minted: a Google service account gives out access tokens that expire,
 * not a key that can be read from configuration once at boot.
 *
 * Writing is a separate shape, and has to be. DuckDB can `COPY … TO` a local
 * path and an `s3://` URI, and cannot write anywhere else — reading a
 * `https://` object works and writing one is "not implemented". So a store is
 * asked to *open* a write and say where DuckDB should put the bytes, which for
 * some stores is the object itself and for others is a scratch file that the
 * store uploads when told the write finished.
 */
export interface ObjectStore {
  /** What to put inside `read_parquet(…)` for this key. */
  uri(key: string): string;

  /**
   * SQL to run before any `uri` is touched. Empty for a store that needs no
   * credential. Never contains caller-supplied text.
   */
  session(): Promise<readonly string[]>;

  /** Opens a write of one object. Nothing is published until `commit`. */
  beginWrite(key: string): Promise<PendingWrite>;

  stat(key: string): Promise<{ bytes: number } | null>;

  remove(keys: readonly string[]): Promise<void>;

  /** Everything under a prefix. Used when a table or an ingot is destroyed. */
  removePrefix(prefix: string): Promise<void>;

  /** For the log line at boot that says where data is actually going. */
  describe(): string;
}

/**
 * One object being written.
 *
 * Two-phase because the store that stages locally has to be told the difference
 * between "DuckDB finished" and "DuckDB threw halfway through": the first
 * uploads, the second deletes a partial file that must never be published. A
 * store writing straight at the object has nothing to do in either, and says so
 * by doing nothing.
 */
export interface PendingWrite {
  /** What to put inside `COPY … TO`. A URI, or a local path. */
  readonly target: string;

  /** Makes the object readable at `uri(key)`. */
  commit(): Promise<void>;

  /** Throws away a write that did not finish. Never throws itself. */
  discard(): Promise<void>;
}

export const OBJECT_STORE = Symbol('ObjectStore');

/**
 * Where an ingot's data lives, in one place.
 *
 * Keys are built here rather than in the compaction handler so that the layout
 * is a thing that can be read in one file — and so that `removePrefix` and the
 * writer cannot disagree about what belongs to a table.
 *
 * The generation is in the path, not just the manifest. That is what lets a
 * compaction publish generation n+1 while queries are still reading n: the two
 * are different objects, and reaping the old one is a separate, later decision.
 */
export const Keys = {
  ingot: (accountId: string, ingotId: string): string => `${accountId}/${ingotId}`,

  table: (accountId: string, ingotId: string, table: string): string =>
    `${Keys.ingot(accountId, ingotId)}/tables/${table}`,

  generation: (accountId: string, ingotId: string, table: string, generation: number): string =>
    `${Keys.table(accountId, ingotId, table)}/gen-${String(generation).padStart(6, '0')}`,

  part: (
    accountId: string,
    ingotId: string,
    table: string,
    generation: number,
    part: number,
  ): string =>
    `${Keys.generation(accountId, ingotId, table, generation)}/part-${String(part).padStart(4, '0')}.parquet`,

  /** Vectors live beside the data, keyed by `_row_id`, never inside it. */
  vectors: (accountId: string, ingotId: string, table: string, generation: number): string =>
    `${Keys.ingot(accountId, ingotId)}/vectors/${table}/gen-${String(generation).padStart(6, '0')}/part-0000.parquet`,
};
