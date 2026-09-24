import { Injectable } from '@nestjs/common';
import { count, eq, gte, lt, sql } from 'drizzle-orm';
import type { FileExtraction } from '@ingot/shared/ingot-v1';
import { CLAIM_LEASE_MS } from '../../../../shared/claim-lease.js';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import type { FileQueue, PendingFile } from '../../application/ports/file-queue.port.js';
import type { MediaType } from '../../domain/media-type.js';
import { fileQueue } from './schema.js';

/**
 * What the claiming statement returns. Drizzle's `execute` wants a plain row
 * type, so the port's interface is restated with an index signature.
 */
type FileRow = PendingFile & Record<string, unknown>;

@Injectable()
export class PgFileQueue implements FileQueue {
  constructor(private readonly uow: PgUnitOfWork) {}

  async enqueue(input: {
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
  }): Promise<void> {
    // The id is minted per upload; `onConflictDoNothing` handles a retried request.
    await this.uow.queryable.insert(fileQueue).values(input).onConflictDoNothing();
  }

  /**
   * The oldest document nobody else holds, leased and counted, in one statement.
   *
   * A select-then-update would let another worker claim the same document. The
   * `+ 1` makes `attempts` trustworthy even against an input that kills the worker.
   */
  async claim(maxAttempts: number, now: Date): Promise<PendingFile | null> {
    const expiry = new Date(now.getTime() - CLAIM_LEASE_MS);

    const claimed = await this.uow.queryable.execute<FileRow>(sql`
      UPDATE ${fileQueue}
      SET claimed_at = ${now}, attempts = attempts + 1
      WHERE file_id = (
        SELECT file_id FROM ${fileQueue}
        WHERE attempts < ${maxAttempts}
          AND (claimed_at IS NULL OR claimed_at < ${expiry})
        ORDER BY queued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING file_id AS "fileId", ingot_id AS "ingotId", object_key AS "objectKey",
                filename, media_type AS "mediaType", bytes, sha256,
                external_id AS "externalId", extract,
                chunk_tokens AS "chunkTokens", overlap_tokens AS "overlapTokens", attempts
    `);

    return claimed.rows[0] ?? null;
  }

  async complete(fileId: string): Promise<void> {
    await this.uow.queryable.delete(fileQueue).where(eq(fileQueue.fileId, fileId));
  }

  /** The attempt was charged by the claim; this keeps the reason and clears the lease. */
  async fail(fileId: string, reason: string): Promise<void> {
    await this.uow.queryable
      .update(fileQueue)
      .set({ lastError: reason, claimedAt: null })
      .where(eq(fileQueue.fileId, fileId));
  }

  async lastErrorOf(fileId: string): Promise<string | null> {
    const [row] = await this.uow.queryable
      .select({ lastError: fileQueue.lastError })
      .from(fileQueue)
      .where(eq(fileQueue.fileId, fileId));
    return row?.lastError ?? null;
  }

  async pending(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(fileQueue)
      .where(lt(fileQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }

  async abandoned(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(fileQueue)
      .where(gte(fileQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }

  async purgeIngot(ingotId: string): Promise<void> {
    await this.uow.queryable.delete(fileQueue).where(eq(fileQueue.ingotId, ingotId));
  }
}
