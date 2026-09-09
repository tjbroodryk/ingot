import type { FileExtraction } from '@ingot/shared/ingot-v1';
import type { MediaType } from '../../domain/media-type.js';

/** A document accepted and not yet parsed. Everything a worker needs to read it. */
export interface PendingFile {
  readonly fileId: string;
  readonly ingotId: string;
  /**
   * Where the bytes are, resolved when the upload was accepted.
   *
   * Stored rather than rebuilt from `Keys.file` at claim time, for the reason
   * `receipt_delivery_queue.target` is stored: the row should record where it
   * actually put something, not re-derive it later from three values that have
   * each had an opportunity to move.
   */
  readonly objectKey: string;
  readonly filename: string;
  readonly mediaType: MediaType;
  readonly bytes: number;
  readonly sha256: string;
  /** The caller's own handle for the document, or null if they gave none. */
  readonly externalId: string | null;
  /** Typed rows to pull out of it, or null for chunks alone. */
  readonly extract: FileExtraction | null;
  /** The caller's chunking knobs. Null means the format's own defaults. */
  readonly chunkTokens: number | null;
  readonly overlapTokens: number | null;
  /** Including this one — the count is charged by the claim itself. */
  readonly attempts: number;
}

/**
 * Documents accepted, waiting to be read.
 *
 * **This queue is the reason `/file` can return in milliseconds**, and the
 * argument for it is the one `overlay_receipt_queue` already makes with more
 * force. Parsing a two-hundred-page PDF is seconds to minutes; `Dispatcher.send`
 * opens a Postgres transaction around every command; the pool holds ten
 * connections. A command that accepted bytes *and* parsed them would hold one
 * of those ten for the length of a document, and a handful of concurrent
 * uploads would starve the requests this service exists to answer — while
 * presenting as a database problem.
 *
 * So the shape is the house one, for the fourth time:
 *
 * ```
 * ClaimFile     tx ~1ms   leases the row, counts the attempt
 *   parse → chunk → extract    no transaction, no connection held
 * WriteFile     tx ~2ms   the rows into the overlay, out of the queue
 * ```
 *
 * `enqueue` is the only method here that belongs in a request's transaction,
 * and it must be in the same one that accepted the upload — a queued parse of
 * bytes that a rollback took away is a worker fetching an object that is not
 * there.
 *
 * The bytes themselves are **not** in this table. They are in the object store,
 * where the base tier already lives, because a fifty-megabyte deck in a `jsonb`
 * column is exactly the failure `INGOT_STORAGE` exists to prevent. Keeping them
 * after the parse is what makes re-chunking possible later: every decision in
 * `Chunker` is baked into rows at write time and rows are append-only, so the
 * only way to change one's mind is to read the document again.
 */
export interface FileQueue {
  /**
   * Records a document that wants parsing. **Inside the transaction that
   * accepted it**, so the row and the intention land together or not at all.
   *
   * Idempotent on the file id, which this service generated: one upload is one
   * row, and a retried request that reuses an id collapses onto it rather than
   * parsing the same bytes twice.
   */
  enqueue(input: {
    fileId: string;
    ingotId: string;
    objectKey: string;
    filename: string;
    mediaType: MediaType;
    bytes: number;
    sha256: string;
    externalId: string | null;
    extract: FileExtraction | null;
    chunkTokens: number | null;
    overlapTokens: number | null;
    queuedAt: Date;
  }): Promise<void>;

  /**
   * Takes the oldest document nobody else is reading, and leases it.
   *
   * One at a time, because the next step is a parse and possibly a model call,
   * and the caller wants its transaction back before either. The lease is what
   * stops a second replica parsing the same document while the first is at it,
   * and it expires so a worker that died mid-parse does not strand the row.
   *
   * **The claim is what counts the attempt**, and it matters more here than
   * anywhere else in the service. The other queues are bounded by somebody
   * else's latency; this one can be killed by its own input — a malformed PDF
   * that takes a decoder down with it never reaches a failure handler, so a
   * counter written there would never move and that document would be retried
   * until somebody noticed. Charging at the door makes every claim cost one,
   * whatever becomes of the worker.
   *
   * Null when the queue is empty, when everything left is leased, or when
   * everything left has failed too often — all the same answer to a sweeper.
   */
  claim(maxAttempts: number, now: Date): Promise<PendingFile | null>;

  /** Parsed and written: the row leaves the queue. */
  complete(fileId: string): Promise<void>;

  /**
   * Not parsed: keep the reason, and hand the row back before its lease is up.
   *
   * The attempt was already charged by the claim, so this only explains and
   * releases. Releasing matters for the transient half — a summariser that
   * timed out is worth another go on the next tick, not in five minutes when
   * the lease would have lapsed on its own.
   */
  fail(fileId: string, reason: string): Promise<void>;

  /** What a worker has given up on, so a terminal row can say why. */
  lastErrorOf(fileId: string): Promise<string | null>;

  /** Queued and still winnable. The gauge that says parsing is behind. */
  pending(maxAttempts: number): Promise<number>;

  /**
   * Queued and out of attempts. Not retried; kept so somebody can look.
   *
   * Apart from `pending` because they mean opposite things: a backlog clears on
   * its own, and an abandoned document is a caller holding two queries that
   * will stay empty for good.
   */
  abandoned(maxAttempts: number): Promise<number>;

  /** Drops a memory's unparsed uploads, when the memory itself goes. */
  purgeIngot(ingotId: string): Promise<void>;
}

export const FILE_QUEUE = Symbol('FileQueue');
