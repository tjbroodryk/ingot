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
 * What the claiming statement returns.
 *
 * Hand-written SQL rather than the query builder, for the reason the other two
 * claims are: this is one `UPDATE … RETURNING` over a `SELECT … FOR UPDATE SKIP
 * LOCKED`, the shape that claims and leases in a single statement, and the one
 * thing that must not become select-then-update. Drizzle's `execute` needs a
 * plain row type, so the port's interface is restated with an index signature.
 */
type DeliveryRow = PendingDelivery & Record<string, unknown>;

/**
 * The outbox, in Postgres, beside everything else this service owns.
 *
 * Postgres rather than a broker, even though one of the transports *is* a
 * broker. The property that matters is that the intention to deliver commits
 * with the receipt it announces, and only the database the receipt is written
 * to can offer that — a publish to RabbitMQ inside a Postgres transaction is
 * exactly the two-phase problem this table exists to avoid.
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
    // `onConflictDoNothing` because one receipt is one delivery: a batch
    // already announced is one already queued, and announcing it twice must
    // not send it twice.
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
   * The oldest delivery nobody else holds, leased and counted.
   *
   * One statement, and it has to be. The transaction ends the moment this
   * returns — the endpoint is called afterwards, with the connection given
   * back — so a select followed by an update would be a window in which a
   * second worker takes the same row and a receiver is told twice.
   *
   * The `+ 1` is why `attempts` is trustworthy. A worker killed by the very
   * delivery it is making never reaches `fail`, so a counter written there
   * would never move and that row would be retried for ever.
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
