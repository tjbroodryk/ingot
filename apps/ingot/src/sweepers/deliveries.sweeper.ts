import { DeliveryWorker } from '../contexts/records/application/delivery-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/**
 * Sends the receipts a memory's delivery target was promised.
 *
 * The same two ways in as the other two workers, for the same reasons.
 * `WriteReceipt` wakes this on commit, so a receiver hears about a receipt
 * about as fast as the model wrote it; this tick is the floor under a wake that
 * never arrived.
 *
 * The floor matters more here than anywhere else in the service. The other
 * queues fail because *we* are behind; this one fails because somebody else's
 * endpoint is down, which lasts minutes rather than milliseconds and is the
 * ordinary case rather than the exception. Every retry after the first attempt
 * is this tick.
 */
@Cron({
  name: 'sweep-deliveries',
  everyMs: EVERY,
  description: 'Delivers receipts to the targets their memories nominated',
})
export class DeliveriesSweeper {
  constructor(private readonly worker: DeliveryWorker) {}

  async tick(): Promise<void> {
    // Not one drain: a worker bounds each drain so it yields, and a tick that
    // called it once turned that yield point into a rate limit of one drain a
    // minute. `drainWithin` keeps going while the queue outlasts a drain, and
    // stops at the moment the next tick would have started.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
