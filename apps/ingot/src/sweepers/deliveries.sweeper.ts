import { DeliveryWorker } from '../contexts/records/application/delivery-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/** Delivers receipts to the targets their memories nominated. */
@Cron({
  name: 'sweep-deliveries',
  everyMs: EVERY,
  description: 'Delivers receipts to the targets their memories nominated',
})
export class DeliveriesSweeper {
  constructor(private readonly worker: DeliveryWorker) {}

  async tick(): Promise<void> {
    // Keep draining while the queue outlasts a single bounded drain, up to one interval.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
