import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';

/**
 * Sends one delivery, somewhere outside this process.
 *
 * The other half of the outbox. `DeliveryOutbox` records *that* a receipt wants
 * announcing, inside the transaction that wrote it; this sends it, outside any
 * transaction at all — which is the arrangement that lets it be slow, be
 * refused, and be tried again without any of that touching the receipt.
 *
 * **Implementations are expected to throw.** That is the difference between
 * this port and the one it replaced: a notifier called from inside the write
 * had to swallow everything, because a failure would have unwound a summary a
 * model was already paid for. Here a throw is the ordinary way to say "not
 * delivered" — the worker counts the attempt, keeps the reason, and the row
 * stays in the queue for the next pass.
 *
 * A transport must not retry internally beyond absorbing an obvious blip. The
 * durable retry lives in the queue, where it survives a restart; a transport
 * that slept through a backoff ladder would be holding a worker instead.
 */
export interface DeliveryTransport {
  /**
   * Delivers, or throws saying why.
   *
   * `target` is the strategy as it was when the receipt was announced, read off
   * the outbox row rather than off the memory — a memory reconfigured mid-flight
   * does not retarget deliveries already in the queue.
   */
  deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void>;
}

export const DELIVERY_TRANSPORT = Symbol('DeliveryTransport');

/**
 * A delivery that was refused rather than lost.
 *
 * Carries the status so the worker's log says whether anybody should act: a
 * 404 on a webhook is a memory pointing at an endpoint that no longer exists
 * and no number of retries will fix it, which is a different conversation from
 * a 503.
 */
export class DeliveryRefused extends Error {
  constructor(
    readonly kind: string,
    readonly detail: string,
    readonly status?: number,
  ) {
    super(status === undefined ? `${kind}: ${detail}` : `${kind} answered ${status}: ${detail}`);
    this.name = 'DeliveryRefused';
  }
}
