import type { FileExtraction } from '@ingot/shared/ingot-v1';
import type { MediaType } from '../../domain/media-type.js';

/** A document accepted and not yet parsed. Everything a worker needs to read it. */
export interface PendingFile {
  readonly fileId: string;
  readonly ingotId: string;
  /** Where the bytes are, resolved when the upload was accepted. */
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
 * The bytes are in the object store, not this table; keeping them after the
 * parse is what makes re-chunking possible, since chunking decisions are baked
 * into append-only rows.
 */
export interface FileQueue {
  /**
   * Records a document that wants parsing, inside the transaction that accepted
   * it. Idempotent on the file id, so a retried upload collapses onto one row.
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
   * The claim counts the attempt, so an input that kills the worker reading it
   * still costs one. Null when the queue is empty, all leased, or all out of
   * attempts.
   */
  claim(maxAttempts: number, now: Date): Promise<PendingFile | null>;

  /** Parsed and written: the row leaves the queue. */
  complete(fileId: string): Promise<void>;

  /** Not parsed: keep the reason and release the lease before it is up. */
  fail(fileId: string, reason: string): Promise<void>;

  /** What a worker has given up on, so a terminal row can say why. */
  lastErrorOf(fileId: string): Promise<string | null>;

  /** Queued and still winnable. The gauge that says parsing is behind. */
  pending(maxAttempts: number): Promise<number>;

  /** Queued and out of attempts. Not retried; kept so it stays countable. */
  abandoned(maxAttempts: number): Promise<number>;

  /** Drops a memory's unparsed uploads, when the memory itself goes. */
  purgeIngot(ingotId: string): Promise<void>;
}

export const FILE_QUEUE = Symbol('FileQueue');
