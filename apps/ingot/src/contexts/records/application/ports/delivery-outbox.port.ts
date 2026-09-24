import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';

/** A delivery that has been announced and not yet sent. */
export interface PendingDelivery {
  /** The receipt's batch. One delivery per receipt, and its identity. */
  readonly batch: string;
  readonly ingotId: string;
  /** Where this was going when it was announced, not where the memory points now. */
  readonly target: DeliveryStrategy;
  /** The body, as it was rendered when the receipt was written. */
  readonly payload: DeliveredReceipt;
  /** Charged by the claim. 1 on the first attempt. */
  readonly attempts: number;
}

/**
 * Receipts announced, waiting to be sent. `enqueue` writes the intention in the
 * receipt's transaction and the worker sends afterwards, so neither a rollback
 * nor a crash between commit and send loses or duplicates it. The target is
 * stored at enqueue, so an in-flight delivery is not retargeted.
 */
export interface DeliveryOutbox {
  /**
   * Records that a receipt wants announcing, inside the receipt's own
   * transaction. Idempotent on the batch.
   */
  enqueue(input: {
    batch: string;
    ingotId: string;
    target: DeliveryStrategy;
    payload: DeliveredReceipt;
    queuedAt: Date;
  }): Promise<void>;

  /**
   * Takes the oldest delivery nobody else is working on, and leases it. The
   * lease stops a second worker sending it and expires if one dies mid-call; the
   * claim counts the attempt. Null when nothing is claimable.
   */
  claim(maxAttempts: number, now: Date): Promise<PendingDelivery | null>;

  /** Sent: the row leaves the queue. */
  complete(batch: string): Promise<void>;

  /**
   * Not sent: keep the reason, and hand the row back before its lease is up. The
   * claim already counted the attempt, so this only explains and releases.
   */
  fail(batch: string, reason: string): Promise<void>;

  /** Queued and still winnable. The gauge that says delivery is behind. */
  pending(maxAttempts: number): Promise<number>;

  /** Queued and out of attempts. Not retried; kept for inspection. */
  abandoned(maxAttempts: number): Promise<number>;

  /** Drops a memory's undelivered announcements when the memory itself goes. */
  purgeIngot(ingotId: string): Promise<void>;
}

export const DELIVERY_OUTBOX = Symbol('DeliveryOutbox');
