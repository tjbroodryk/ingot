/**
 * A receipt that has just become findable.
 *
 * Carries the query rather than only the ids, because that is what the caller
 * was given at `/add` and what any later delivery has to agree with. A webhook
 * that said "receipt ready for batch_1508c8" and left the recipient to
 * reconstruct the SQL would be a second contract, and the two would drift.
 */
export interface ReceiptReady {
  /**
   * The memory, not the account. The delivery target is registered against one
   * of these, and an adapter that needs the tenant can resolve it — where
   * carrying an account id through the queue would be a column written for a
   * feature that does not exist.
   */
  readonly ingotId: string;
  readonly batch: string;
  /** The caller's own handle for the result, or null if they gave none. */
  readonly externalId: string | null;
  readonly sourceTable: string;
  readonly summary: string;
  readonly searchTerm: string;
  /** How many rows the `/add` this describes stored. */
  readonly rows: number;
  /** The SELECT that returns it — the same string the receipt handed back. */
  readonly query: string;
  readonly model: string;
  /** When it became findable. Stable across redeliveries. */
  readonly readyAt: Date;
}

/**
 * Told when a receipt lands, from inside the transaction that wrote it.
 *
 * ## Why this is a seam and not a `fetch`
 *
 * Delivery cannot happen here, and the reason is the whole design. This is
 * called inside the receipt's own transaction, so anything that left the
 * process from here would be announcing state a rollback could still take
 * away — and nothing outside the database rolls back with it. Moving the call
 * after the commit fixes that and introduces the opposite failure: the process
 * dies between the COMMIT and the call, the receipt exists, nobody was told,
 * and nothing will ever tell them. Both are silent.
 *
 * So what happens here is a *write*: the intention to deliver is recorded in
 * the outbox, in this transaction, and something else sends it afterwards. The
 * receipt and the promise to announce it land together or not at all, and the
 * announcement itself is free to be slow, be refused, and be tried again.
 *
 * ## What implementations owe
 *
 * **They must not throw**, and now they can honestly promise not to: what is
 * being asked of them is a row in a table the transaction is already holding
 * open, not somebody else's HTTP endpoint. A notifier that failed here would
 * unwind a summary a model has already been paid for.
 *
 * `OutboxReceiptNotifier` is the only implementation, and `DeliveryWorker` is
 * what drains what it writes.
 */
export interface ReceiptNotifier {
  ready(receipt: ReceiptReady): Promise<void>;
}

export const RECEIPT_NOTIFIER = Symbol('ReceiptNotifier');
