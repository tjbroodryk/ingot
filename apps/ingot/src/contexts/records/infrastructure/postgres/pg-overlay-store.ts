import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, lt, lte, min, notExists, or, sql } from 'drizzle-orm';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import type { MappedRow } from '../../domain/row-mapping.vo.js';
import {
  CLAIM_LEASE_MS,
  type OverlayDepth,
  type OverlayRow,
  type OverlayStore,
  type PendingReceipt,
  type PendingEmbedding,
} from '../../application/ports/overlay-store.port.js';
import {
  overlayReceiptQueue,
  overlayEmbedQueue,
  overlayRow,
  overlayTombstone,
  overlayVector,
} from './schema.js';

/** Postgres caps a statement's parameters at 65535; stay well inside it. */
const INSERT_CHUNK = 500;

/**
 * What the two claiming statements return. Hand-written SQL (one `UPDATE …
 * RETURNING` over `SELECT … FOR UPDATE SKIP LOCKED`), which must not become
 * select-then-update; `execute` needs a plain row type, hence the index signature.
 */
type EmbeddingRow = PendingEmbedding & Record<string, unknown>;
type ReceiptRow = PendingReceipt & Record<string, unknown>;

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < values.length; at += size) chunks.push(values.slice(at, at + size));
  return chunks;
}

@Injectable()
export class PgOverlayStore implements OverlayStore {
  constructor(private readonly uow: PgUnitOfWork) {}

  async append(input: {
    ingotId: string;
    tableId: string;
    rows: readonly MappedRow[];
    embeddable: readonly string[];
  }): Promise<number> {
    if (input.rows.length === 0) return 0;
    const now = new Date();

    for (const chunk of chunked(input.rows, INSERT_CHUNK)) {
      await this.uow.queryable.insert(overlayRow).values(
        chunk.map((payload) => ({
          ingotId: input.ingotId,
          tableId: input.tableId,
          rowId: String(payload._row_id),
          payload,
          ingestedAt: now,
        })),
      );
    }

    if (input.embeddable.length === 0) return 0;

    // Only rows carrying text are queued; a null in an embeddable column has
    // nothing to embed, not a late vector.
    const queued = input.rows.flatMap((payload) =>
      input.embeddable
        .map((column) => ({ column, text: payload[column] }))
        .filter(
          (candidate): candidate is { column: string; text: string } =>
            typeof candidate.text === 'string' && candidate.text.trim().length > 0,
        )
        .map((candidate) => ({
          tableId: input.tableId,
          rowId: String(payload._row_id),
          columnName: candidate.column,
          text: candidate.text,
          queuedAt: now,
        })),
    );

    for (const chunk of chunked(queued, INSERT_CHUNK)) {
      await this.uow.queryable.insert(overlayEmbedQueue).values(chunk).onConflictDoNothing();
    }
    return queued.length;
  }

  async read(tableId: string, throughSeq?: bigint): Promise<readonly OverlayRow[]> {
    const rows = await this.uow.queryable
      .select({ rowId: overlayRow.rowId, seq: overlayRow.seq, payload: overlayRow.payload })
      .from(overlayRow)
      .where(
        throughSeq === undefined
          ? eq(overlayRow.tableId, tableId)
          : and(eq(overlayRow.tableId, tableId), lte(overlayRow.seq, throughSeq)),
      )
      .orderBy(asc(overlayRow.seq));
    return rows;
  }

  async watermark(tableId: string): Promise<bigint | null> {
    const [row] = await this.uow.queryable
      .select({ high: sql<string | null>`max(${overlayRow.seq})` })
      .from(overlayRow)
      .where(eq(overlayRow.tableId, tableId));
    return row?.high == null ? null : BigInt(row.high);
  }

  async count(tableId: string): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(overlayRow)
      .where(eq(overlayRow.tableId, tableId));
    return row?.n ?? 0;
  }

  async tombstones(tableId: string): Promise<readonly string[]> {
    const rows = await this.uow.queryable
      .select({ rowId: overlayTombstone.rowId })
      .from(overlayTombstone)
      .where(eq(overlayTombstone.tableId, tableId));
    return rows.map((row) => row.rowId);
  }

  async countTombstones(tableId: string): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(overlayTombstone)
      .where(eq(overlayTombstone.tableId, tableId));
    return row?.n ?? 0;
  }

  async forget(tableId: string, rowIds: readonly string[], at: Date): Promise<void> {
    if (rowIds.length === 0) return;
    for (const chunk of chunked(rowIds, INSERT_CHUNK)) {
      await this.uow.queryable
        .insert(overlayTombstone)
        .values(chunk.map((rowId) => ({ tableId, rowId, at })))
        .onConflictDoNothing();
    }
  }

  /**
   * Drops what a roll-up consumed, and only that. Bounded by the compaction's
   * watermark, never a bare delete: rows above it are not in the new file. Spent
   * tombstones go too; one for a row still above the watermark stays.
   */
  async drain(tableId: string, throughSeq: bigint | null): Promise<void> {
    const consumed =
      throughSeq === null
        ? []
        : await this.uow.queryable
            .select({ rowId: overlayRow.rowId })
            .from(overlayRow)
            .where(and(eq(overlayRow.tableId, tableId), lte(overlayRow.seq, throughSeq)));

    if (throughSeq !== null) {
      await this.uow.queryable
        .delete(overlayRow)
        .where(and(eq(overlayRow.tableId, tableId), lte(overlayRow.seq, throughSeq)));
    }

    const ids = consumed.map((row) => row.rowId);
    for (const chunk of chunked(ids, INSERT_CHUNK)) {
      await this.uow.queryable
        .delete(overlayEmbedQueue)
        .where(
          and(eq(overlayEmbedQueue.tableId, tableId), inArray(overlayEmbedQueue.rowId, chunk)),
        );
      await this.uow.queryable
        .delete(overlayVector)
        .where(and(eq(overlayVector.tableId, tableId), inArray(overlayVector.rowId, chunk)));
    }

    await this.uow.queryable.delete(overlayTombstone).where(
      and(
        eq(overlayTombstone.tableId, tableId),
        notExists(
          this.uow.queryable
            .select({ one: sql`1` })
            .from(overlayRow)
            .where(
              and(eq(overlayRow.tableId, tableId), eq(overlayRow.rowId, overlayTombstone.rowId)),
            ),
        ),
      ),
    );
  }

  async purgeTable(tableId: string): Promise<void> {
    await this.uow.queryable.delete(overlayRow).where(eq(overlayRow.tableId, tableId));
    await this.uow.queryable.delete(overlayTombstone).where(eq(overlayTombstone.tableId, tableId));
    await this.uow.queryable.delete(overlayVector).where(eq(overlayVector.tableId, tableId));
    await this.uow.queryable
      .delete(overlayEmbedQueue)
      .where(eq(overlayEmbedQueue.tableId, tableId));
  }

  async purgeIngot(ingotId: string): Promise<void> {
    const tables = await this.uow.queryable
      .select({ tableId: overlayRow.tableId })
      .from(overlayRow)
      .where(eq(overlayRow.ingotId, ingotId))
      .groupBy(overlayRow.tableId);
    for (const table of tables) await this.purgeTable(table.tableId);
    await this.uow.queryable.delete(overlayRow).where(eq(overlayRow.ingotId, ingotId));
    // Keyed on the ingot and swept here, not in `purgeTable`: a queued receipt
    // names the source table, so a memory destroyed before its sweep would leave
    // work resolving to a table that no longer exists.
    await this.uow.queryable
      .delete(overlayReceiptQueue)
      .where(eq(overlayReceiptQueue.ingotId, ingotId));
  }

  /**
   * Tables worth rewriting Parquet for: a deep overlay has rows to fold in, and
   * any tombstone has rows to leave out. A delete writes no overlay rows, so a
   * table only ever deleted from qualifies on tombstones alone.
   */
  async tablesWorthCompacting(
    minimumRows: number,
    limit: number,
  ): Promise<readonly OverlayDepth[]> {
    const deep = await this.uow.queryable
      .select({
        tableId: overlayRow.tableId,
        rows: count(),
        oldest: min(overlayRow.ingestedAt),
      })
      .from(overlayRow)
      .groupBy(overlayRow.tableId)
      .having(sql`count(*) >= ${minimumRows}`)
      .limit(limit);

    const forgotten = await this.uow.queryable
      .select({
        tableId: overlayTombstone.tableId,
        tombstones: count(),
        oldest: min(overlayTombstone.at),
      })
      .from(overlayTombstone)
      .groupBy(overlayTombstone.tableId)
      .limit(limit);

    const merged = new Map<string, OverlayDepth>();
    for (const row of deep) {
      merged.set(row.tableId, {
        tableId: row.tableId,
        rows: row.rows,
        tombstones: 0,
        oldest: row.oldest ?? new Date(),
      });
    }
    for (const row of forgotten) {
      const existing = merged.get(row.tableId);
      merged.set(row.tableId, {
        tableId: row.tableId,
        rows: existing?.rows ?? 0,
        tombstones: row.tombstones,
        oldest: existing?.oldest ?? row.oldest ?? new Date(),
      });
    }
    return [...merged.values()].slice(0, limit);
  }

  /**
   * Leases up to `limit` texts, oldest first. One statement: select-then-update
   * would hand the same texts to two workers. `FOR UPDATE SKIP LOCKED` holds the
   * rows for the statement; `claimed_at` holds them while the model is asked.
   */
  async claimPending(limit: number, now: Date): Promise<readonly PendingEmbedding[]> {
    const expiry = new Date(now.getTime() - CLAIM_LEASE_MS);

    const claimed = await this.uow.queryable.execute<EmbeddingRow>(sql`
      UPDATE ${overlayEmbedQueue} SET claimed_at = ${now}
      WHERE (table_id, row_id, column_name) IN (
        SELECT table_id, row_id, column_name FROM ${overlayEmbedQueue}
        WHERE claimed_at IS NULL OR claimed_at < ${expiry}
        ORDER BY queued_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING table_id AS "tableId", row_id AS "rowId",
                column_name AS "column", text
    `);

    return claimed.rows;
  }

  async releasePending(entries: readonly PendingEmbedding[]): Promise<void> {
    if (entries.length === 0) return;

    for (const chunk of chunked(entries, INSERT_CHUNK)) {
      await this.uow.queryable
        .update(overlayEmbedQueue)
        .set({ claimedAt: null })
        .where(
          or(
            ...chunk.map((entry) =>
              and(
                eq(overlayEmbedQueue.tableId, entry.tableId),
                eq(overlayEmbedQueue.rowId, entry.rowId),
                eq(overlayEmbedQueue.columnName, entry.column),
              ),
            ),
          ),
        );
    }
  }

  async saveVectors(
    vectors: readonly {
      tableId: string;
      rowId: string;
      column: string;
      vector: readonly number[];
    }[],
    model: string,
  ): Promise<void> {
    if (vectors.length === 0) return;

    for (const chunk of chunked(vectors, 100)) {
      await this.uow.queryable
        .insert(overlayVector)
        .values(
          chunk.map((entry) => ({
            tableId: entry.tableId,
            rowId: entry.rowId,
            columnName: entry.column,
            model,
            dims: entry.vector.length,
            vector: [...entry.vector],
          })),
        )
        .onConflictDoUpdate({
          target: [overlayVector.tableId, overlayVector.rowId, overlayVector.columnName],
          set: {
            model: sql`excluded.model`,
            dims: sql`excluded.dims`,
            vector: sql`excluded.vector`,
          },
        });

      // Leaving the queue marks a row done; same transaction as the vector, so
      // a crash between the two just re-embeds it.
      for (const entry of chunk) {
        await this.uow.queryable
          .delete(overlayEmbedQueue)
          .where(
            and(
              eq(overlayEmbedQueue.tableId, entry.tableId),
              eq(overlayEmbedQueue.rowId, entry.rowId),
              eq(overlayEmbedQueue.columnName, entry.column),
            ),
          );
      }
    }
  }

  async readVectors(
    tableId: string,
    column: string,
  ): Promise<readonly { rowId: string; vector: readonly number[] }[]> {
    return this.uow.queryable
      .select({ rowId: overlayVector.rowId, vector: overlayVector.vector })
      .from(overlayVector)
      .where(and(eq(overlayVector.tableId, tableId), eq(overlayVector.columnName, column)));
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.uow.queryable.select({ n: count() }).from(overlayEmbedQueue);
    return row?.n ?? 0;
  }

  async totalRows(): Promise<number> {
    const [row] = await this.uow.queryable.select({ n: count() }).from(overlayRow);
    return row?.n ?? 0;
  }

  // ── receipts ─────────────────────────────────────────────────────────────

  async queueReceipt(input: {
    batch: string;
    externalId: string | null;
    ingotId: string;
    tableId: string;
    sourceTable: string;
    body: unknown;
    rows: number;
    queuedAt: Date;
  }): Promise<void> {
    // One `/add` is one batch; `onConflictDoNothing` is for the identical-write
    // retry, not a collision.
    await this.uow.queryable
      .insert(overlayReceiptQueue)
      .values({
        batch: input.batch,
        externalId: input.externalId,
        ingotId: input.ingotId,
        tableId: input.tableId,
        sourceTable: input.sourceTable,
        body: input.body,
        rows: input.rows,
        queuedAt: input.queuedAt,
      })
      .onConflictDoNothing();
  }

  /**
   * The oldest receipt nobody else holds, leased and counted. One statement, so
   * select-then-update cannot let a second worker take the same row. The `+ 1`
   * counts the attempt here, since a worker killed mid-write never reaches
   * `failReceipt`.
   */
  async claimReceipt(maxAttempts: number, now: Date): Promise<PendingReceipt | null> {
    const expiry = new Date(now.getTime() - CLAIM_LEASE_MS);

    const claimed = await this.uow.queryable.execute<ReceiptRow>(sql`
      UPDATE ${overlayReceiptQueue}
      SET claimed_at = ${now}, attempts = attempts + 1
      WHERE batch = (
        SELECT batch FROM ${overlayReceiptQueue}
        WHERE attempts < ${maxAttempts}
          AND (claimed_at IS NULL OR claimed_at < ${expiry})
        ORDER BY queued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING batch, external_id AS "externalId", ingot_id AS "ingotId", table_id AS "tableId",
                source_table AS "sourceTable", body, rows, attempts
    `);

    return claimed.rows[0] ?? null;
  }

  async completeReceipt(batch: string): Promise<void> {
    await this.uow.queryable
      .delete(overlayReceiptQueue)
      .where(eq(overlayReceiptQueue.batch, batch));
  }

  /** The claim already counted the attempt, so this only records the reason and clears the lease. */
  async failReceipt(batch: string, reason: string): Promise<void> {
    await this.uow.queryable
      .update(overlayReceiptQueue)
      .set({ lastError: reason, claimedAt: null })
      .where(eq(overlayReceiptQueue.batch, batch));
  }

  async receiptsPending(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(overlayReceiptQueue)
      .where(lt(overlayReceiptQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }

  async receiptsAbandoned(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(overlayReceiptQueue)
      .where(gte(overlayReceiptQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }
}
