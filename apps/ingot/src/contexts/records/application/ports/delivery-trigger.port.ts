/**
 * Something that can be told there is delivery work waiting.
 *
 * A port for one method, and it exists to break an import cycle that is real
 * rather than accidental. `BackgroundWork` holds all three workers, and
 * `ReceiptWorker` dispatches `WriteReceipt` — so a `WriteReceipt` handler that
 * imported `BackgroundWork` directly would close the loop
 * `background → receipt-worker → write-receipt → background`, and Nest would
 * fail to evaluate the decorator on whichever module loaded first.
 *
 * `AddRecordsHandler` injects `BackgroundWork` itself and is fine, because
 * nothing in that chain imports it back. This one is not, so the seam is here.
 *
 * The narrowness is a feature rather than an apology: what `WriteReceipt`
 * actually needs is to say "there is something to deliver", not the whole
 * background. Bound to `BackgroundWork`, which coalesces the wake and swallows
 * a failed drain — the sweeper is the floor under it either way.
 */
export interface DeliveryTrigger {
  wakeDeliveries(): void;
}

export const DELIVERY_TRIGGER = Symbol('DeliveryTrigger');
