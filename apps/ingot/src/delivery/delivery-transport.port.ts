import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';

/**
 * Sends one delivery outside this process — the sending half of the outbox.
 * Expected to throw to say "not delivered"; the worker counts the attempt and
 * keeps the row. Durable retry lives in the queue, so a transport must not retry
 * internally beyond a blip.
 */
export interface DeliveryTransport {
  /**
   * Delivers, or throws saying why. `target` is the strategy as announced (off
   * the outbox row), so reconfiguring a memory doesn't retarget queued deliveries.
   */
  deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void>;
}

export const DELIVERY_TRANSPORT = Symbol('DeliveryTransport');

/**
 * A delivery refused rather than lost. Carries the status so the log says whether
 * anyone should act: a 404 won't be fixed by retries, unlike a 503.
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
