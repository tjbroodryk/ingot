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
   * The memory, not the account. A delivery target will be registered against
   * one of these, and an adapter that needs the tenant can resolve it — where
   * carrying an account id through the queue would be a column written for a
   * feature that does not exist.
   */
  readonly ingotId: string;
  readonly batch: string;
  readonly sourceTable: string;
  readonly summary: string;
  readonly searchTerm: string;
  /** The SELECT that returns it — the same string the receipt handed back. */
  readonly query: string;
  readonly model: string;
}

/**
 * Told when a receipt lands. The seam a webhook will drop into.
 *
 * Today a receipt is collected by polling: `/add` hands back a SELECT and the
 * caller runs it when it wants the answer. That is the right first shape —
 * it needs no registration, no retry policy and no endpoint to be up — but it
 * is a poor fit for an agent that has moved on and would rather be told.
 *
 * So the call site exists now and the delivery does not. `SummariseNext`
 * announces every receipt it writes through this port, which means adding
 * webhooks later is writing an adapter and binding it, rather than finding
 * every place a receipt could become ready and hoping there was only one.
 *
 * What is deliberately *not* here yet is where to deliver. A target has to
 * come from somewhere a caller can set — a per-memory endpoint, or a field on
 * the `/add` — and neither exists, so inventing a column for it now would be
 * schema nothing writes. That decision belongs to the change that ships
 * delivery, not to this one.
 *
 * Implementations must not throw. This is announced after the receipt is
 * written and inside the same transaction, so a notifier that fails would
 * unwind a summary that a model has already been paid for.
 */
export interface ReceiptNotifier {
  ready(receipt: ReceiptReady): Promise<void>;
}

export const RECEIPT_NOTIFIER = Symbol('ReceiptNotifier');
