/**
 * A receipt that has just become findable. Carries the query, not only the ids,
 * so it matches what the caller was given at `/add`.
 */
export interface ReceiptReady {
  /** The memory, not the account; the delivery target is registered against one of these. */
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
 * Told when a receipt lands, from inside the transaction that wrote it. Records
 * the intention to deliver as an outbox row rather than sending here, so the two
 * commit together. Implementations must not throw.
 */
export interface ReceiptNotifier {
  ready(receipt: ReceiptReady): Promise<void>;
}

export const RECEIPT_NOTIFIER = Symbol('ReceiptNotifier');
