import { Injectable } from '@nestjs/common';
import { count, eq, gte, lt, sql } from 'drizzle-orm';
import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import type {
  DeliveryOutbox,
  PendingDelivery,
} from '../../application/ports/delivery-outbox.port.js';
import { CLAIM_LEASE_MS } from '../../application/ports/overlay-store.port.js';
import { receiptDeliveryQueue } from './schema.js';

/**
 * What the claiming statement returns. Hand-written SQL (one `UPDATE …
 * RETURNING` over `SELECT … FOR UPDATE SKIP LOCKED`), which must not become
 * select-then-update; `execute` needs a plain row type, hence the index signature.
 */
type DeliveryRow = PendingDelivery & Record<string, unknown>;

/**
 * The outbox, in Postgres. Postgres rather than a broker so the intention to
 * deliver commits with the receipt it announces; a publish inside the
 * transaction would be the two-phase problem this table avoids.
 */
@Injectable()
export class PgDeliveryOutbox implements DeliveryOutbox {
  constructor(private readonly uow: PgUnitOfWork) {}

  async enqueue(input: {
    batch: string;
    ingotId: string;
    target: DeliveryStrategy;
    payload: DeliveredReceipt;
    queuedAt: Date;
  }): Promise<void> {
    // One receipt is one delivery: re-announcing must not queue it twice.
    await this.uow.queryable
      .insert(receiptDeliveryQueue)
      .values({
        batch: input.batch,
        ingotId: input.ingotId,
        target: input.target,
        payload: input.payload,
        queuedAt: input.queuedAt,
      })
      .onConflictDoNothing();
  }

  /**
   * The oldest delivery nobody else holds, leased and counted. One statement, so
   * select-then-update cannot let a second worker take the same row. The `+ 1`
   * counts the attempt here, since a worker killed mid-delivery never reaches `fail`.
   */
  async claim(maxAttempts: number, now: Date): Promise<PendingDelivery | null> {
    const expiry = new Date(now.getTime() - CLAIM_LEASE_MS);

    const claimed = await this.uow.queryable.execute<DeliveryRow>(sql`
      UPDATE ${receiptDeliveryQueue}
      SET claimed_at = ${now}, attempts = attempts + 1
      WHERE batch = (
        SELECT batch FROM ${receiptDeliveryQueue}
        WHERE attempts < ${maxAttempts}
          AND (claimed_at IS NULL OR claimed_at < ${expiry})
        ORDER BY queued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING batch, ingot_id AS "ingotId", target, payload, attempts
    `);

    return claimed.rows[0] ?? null;
  }

  async complete(batch: string): Promise<void> {
    await this.uow.queryable
      .delete(receiptDeliveryQueue)
      .where(eq(receiptDeliveryQueue.batch, batch));
  }

  async fail(batch: string, reason: string): Promise<void> {
    await this.uow.queryable
      .update(receiptDeliveryQueue)
      .set({ lastError: reason, claimedAt: null })
      .where(eq(receiptDeliveryQueue.batch, batch));
  }

  async pending(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(receiptDeliveryQueue)
      .where(lt(receiptDeliveryQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }

  async abandoned(maxAttempts: number): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ n: count() })
      .from(receiptDeliveryQueue)
      .where(gte(receiptDeliveryQueue.attempts, maxAttempts));
    return row?.n ?? 0;
  }

  async purgeIngot(ingotId: string): Promise<void> {
    await this.uow.queryable
      .delete(receiptDeliveryQueue)
      .where(eq(receiptDeliveryQueue.ingotId, ingotId));
  }
}
