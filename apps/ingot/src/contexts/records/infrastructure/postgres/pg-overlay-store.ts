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
 * What the two claiming statements return.
 *
 * Both are hand-written SQL rather than a query builder, because both are one
 * `UPDATE … RETURNING` over a `SELECT … FOR UPDATE SKIP LOCKED` — the shape
 * that claims and leases in a single statement, and the one thing that must
 * not become select-then-update. Drizzle's `execute` needs a plain row type,
 * so the port's interfaces are restated here with an index signature.
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

    // Only rows that actually carry text are queued. A null in an embeddable
    // column is a row with nothing to embed, not a row whose vector is late.
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
   * Drops what a roll-up consumed — and only what it consumed.
   *
   * Bounded by the watermark the compaction read at, never a bare delete: rows
   * written while the Parquet was being produced have a higher sequence and
   * are not in the new file, so deleting them here would lose them silently.
   *
   * Spent tombstones go too. Once compaction has written a base file that
   * excludes a forgotten row and its overlay copy is drained, the row is gone
   * from both tiers and its tombstone is filtering nothing — keeping it would
   * make the set grow without bound, which is the thing resolving deletes to
   * ids instead of storing predicates was supposed to avoid.
   *
   * A tombstone for a row still sitting *above* the watermark has to stay: it
   * was not in the file this compaction wrote, so nothing has excluded it yet.
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
    // Keyed on the ingot rather than the table, and swept here rather than in
    // `purgeTable`: a queued receipt names the *source* table, so a memory
    // destroyed before its sweeper ran would otherwise leave work behind that
    // resolves to a table that no longer exists.
    await this.uow.queryable
      .delete(overlayReceiptQueue)
      .where(eq(overlayReceiptQueue.ingotId, ingotId));
  }

  /**
   * Tables worth rewriting Parquet for.
   *
   * Two reasons qualify, and the second is easy to miss: a table with a deep
   * overlay has rows to fold in, and a table with *any* tombstone has rows to
   * leave out. A delete writes no overlay rows at all, so a table that is only
   * ever deleted from would never be swept — its tombstones would accumulate
   * and the forgotten rows would stay in the base file indefinitely, filtered
   * out on every single query forever.
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
   * Leases up to `limit` texts, oldest first.
   *
   * One statement, because two — select then update — is a race that hands the
   * same texts to two workers between them. The inner `SELECT … FOR UPDATE
   * SKIP LOCKED` holds the rows only for the instant this statement runs;
   * `claimed_at` is what holds them afterwards, while the model is being
   * asked and this transaction is long since committed.
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

      // Leaving the queue is what marks a row done. It happens after the
      // vector lands, in the same transaction, so a crash between the two
      // leaves the row queued and it is simply embedded again.
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
    // One `/add` is one batch, so the primary key already says "at most once".
    // `onConflictDoNothing` is for the retry that re-sends an identical write
    // rather than for a collision, which cannot happen.
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
   * The oldest receipt nobody else holds, leased and counted.
   *
   * One statement, and it has to be. The transaction ends the moment this
   * returns — the model is asked afterwards, with the connection given back —
   * so a select followed by an update would be a window in which a second
   * worker claims the same row. `FOR UPDATE SKIP LOCKED` holds it for the
   * instant the statement runs; `claimed_at` holds it for the minutes after.
   *
   * The `+ 1` is why `attempts` is trustworthy. A worker killed by the very
   * body it is describing never reaches `failReceipt`, so a counter written
   * there would never move and that body would be retried for ever. Charging
   * at the door makes every claim cost one, whatever becomes of the worker.
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

  /**
   * The attempt was already counted by the claim, so this explains and lets go.
   *
   * Clearing the lease matters as much as keeping the reason: a model that
   * failed a second ago is worth asking again on the next tick, not in five
   * minutes when the lease would have lapsed on its own.
   */
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
