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

  /**
   * Writes one object from bytes already in hand.
   *
   * **The exception to the rule at the top of this file, and it is worth being
   * clear about why it is not a violation of it.** That rule is about the
   * *Parquet read path*: DuckDB opens those files far better than we would, so
   * handing it a string to open beats fetching a buffer first. It says nothing
   * about objects DuckDB is never going to see.
   *
   * An uploaded document is exactly that. It arrives as bytes over HTTP, it is
   * read by a parser in this process, and no query ever touches it — so there
   * is no engine to defer to and `beginWrite`'s two-phase dance would be
   * ceremony around a single `write`. `PendingWrite` exists so that a store
   * staging locally can tell "DuckDB finished" from "DuckDB threw halfway
   * through"; with the whole payload in memory there is no halfway.
   */
  put(key: string, body: Buffer): Promise<void>;

  /**
   * Reads one object back, whole.
   *
   * For documents, and for the same reason `put` exists. A parser needs the
   * bytes in this process; there is nothing to push a projection down into.
   * Never used on the Parquet path, where `uri` is the answer.
   *
   * Throws rather than returning null when the object is gone: a queued parse
   * whose object has vanished is a real failure that should be recorded on the
   * document, not an empty buffer that parses to nothing and looks like a file
   * with no content in it.
   */
  fetch(key: string): Promise<Buffer>;

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

  /**
   * An uploaded document, as it arrived.
   *
   * Under the memory's own prefix, so destroying a memory takes its documents
   * with it through the `removePrefix` that already removes the Parquet — one
   * deletion path rather than two that can disagree about what was covered.
   *
   * **The name is the file id and never the filename.** A caller-supplied name
   * reaching a path is a write anywhere the process can reach, and no amount of
   * sanitising is as good as not doing it: the id is ours, it is generated, and
   * the filename lives in a column where it can be any bytes at all.
   *
   * No extension either. What the object *is* was decided at upload from the
   * declared type and the bytes together, and it is recorded in `file_queue`
   * and in `ingot_files`. A second copy of that claim in the key would be a
   * second thing to trust, and the one thing that must never happen here is a
   * decoder being chosen by a string a caller supplied.
   */
  file: (accountId: string, ingotId: string, fileId: string): string =>
    `${Keys.ingot(accountId, ingotId)}/files/${fileId}`,
};
