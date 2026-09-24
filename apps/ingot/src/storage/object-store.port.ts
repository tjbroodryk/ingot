/**
 * The base tier: Parquet objects, addressed by key. `uri` hands DuckDB a string
 * to open rather than fetching bytes; `session` runs credential SQL before
 * lockdown; writing goes through `beginWrite`, since DuckDB `COPY … TO` only
 * takes a local path or `s3://`.
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

  /**
   * Writes one object from bytes in hand. For objects DuckDB never reads
   * (uploaded documents), where `beginWrite`'s two-phase dance is needless.
   */
  put(key: string, body: Buffer): Promise<void>;

  /**
   * Reads one object back, whole. For documents a parser needs in-process; never
   * the Parquet path. Throws rather than returning null when the object is gone.
   */
  fetch(key: string): Promise<Buffer>;

  stat(key: string): Promise<{ bytes: number } | null>;

  remove(keys: readonly string[]): Promise<void>;

  /** Everything under a prefix. Used when a table or an ingot is destroyed. */
  removePrefix(prefix: string): Promise<void>;

  /** For the boot log line saying where data is going. */
  describe(): string;
}

/**
 * One object being written. Two-phase for stores that stage locally: `commit`
 * uploads, `discard` deletes a partial. A store writing straight at the object
 * does nothing in both.
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
 * Where an ingot's data lives, in one place, so `removePrefix` and the writer
 * agree on a table's layout. The generation is in the path, so a compaction can
 * publish n+1 while queries still read n.
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

  /**
   * An uploaded document, as it arrived, under the memory's prefix so
   * `removePrefix` takes it too. The name is the file id, never the caller's
   * filename, and carries no extension — the decoder is never chosen from
   * caller-supplied text.
   */
  file: (accountId: string, ingotId: string, fileId: string): string =>
    `${Keys.ingot(accountId, ingotId)}/files/${fileId}`,
};
