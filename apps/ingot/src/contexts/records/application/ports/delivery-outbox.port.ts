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
 * Receipts announced, waiting to be sent.
 *
 * **This is the thing that makes a delivery survive a crash, and it is the
 * whole reason a webhook is not just a `fetch` in `WriteReceipt`.**
 *
 * A push sent from *inside* the transaction that wrote the receipt is a claim
 * about state that a rollback can still take away, and nothing outside the
 * database rolls back with it. A push sent *after* the commit, in process, has
 * the opposite failure: the process dies between the COMMIT and the call, the
 * receipt exists, nobody was told, and nothing will ever tell them. Both are
 * silent. Writing the intention transactionally and sending it afterwards is
 * the only arrangement in which neither can happen — the receipt and the
 * intention to announce it are one atomic write, and the sending is a separate
 * step with its own retries.
 *
 * `enqueue` is therefore the only method here that belongs inside a
 * transaction, and it must be called inside the one that wrote the receipt.
 * The rest are the worker's, and each is its own short transaction with a
 * network call in between.
 *
 * There is no method for "where should this go" on purpose. The target is
 * resolved once, at enqueue, and stored on the row: a memory whose endpoint is
 * changed while a delivery is in flight should not have that delivery silently
 * retargeted at the new one.
 */
export interface DeliveryOutbox {
  /**
   * Records that a receipt wants announcing. **Inside the receipt's own
   * transaction**, so the two land together or not at all.
   *
   * Idempotent on the batch: one receipt is one delivery, and a re-announcement
   * of the same receipt collapses onto the row already there rather than
   * sending twice.
   */
  enqueue(input: {
    batch: string;
    ingotId: string;
    target: DeliveryStrategy;
    payload: DeliveredReceipt;
    queuedAt: Date;
  }): Promise<void>;

  /**
   * Takes the oldest delivery nobody else is working on, and leases it.
   *
   * One at a time, because the next step is somebody else's HTTP endpoint or
   * broker and the caller wants its transaction back before making that call.
   * The lease is what stops a second worker sending the same delivery while the
   * first is in flight, and it expires so a worker that died mid-call does not
   * strand the row.
   *
   * **The claim is what counts the attempt**, for the reason `claimReceipt`
   * gives: a worker killed by the very delivery it is making never reaches a
   * failure handler, so a counter written there would never move.
   *
   * Null when the queue is empty, when everything left is leased, or when
   * everything left has failed too often — all the same answer to a worker.
   */
  claim(maxAttempts: number, now: Date): Promise<PendingDelivery | null>;

  /** Sent: the row leaves the queue. */
  complete(batch: string): Promise<void>;

  /**
   * Not sent: keep the reason, and hand the row back before its lease is up.
   *
   * The attempt was already counted by the claim, so this only explains and
   * releases. Releasing matters: an endpoint that 503'd a second ago is worth
   * trying again on the next tick, not in five minutes when the lease lapses.
   */
  fail(batch: string, reason: string): Promise<void>;

  /** Queued and still winnable. The gauge that says delivery is behind. */
  pending(maxAttempts: number): Promise<number>;

  /** Queued and out of attempts. Not retried; kept so somebody can look. */
  abandoned(maxAttempts: number): Promise<number>;

  /**
   * Drops a memory's undelivered announcements, when the memory itself goes.
   *
   * Announcing a receipt from a memory that no longer exists would hand a
   * receiver a query that can only ever come back empty.
   */
  purgeIngot(ingotId: string): Promise<void>;
}

export const DELIVERY_OUTBOX = Symbol('DeliveryOutbox');
