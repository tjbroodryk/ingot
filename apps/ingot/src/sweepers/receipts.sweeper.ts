import { ReceiptWorker } from '../contexts/records/application/receipt-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/** Writes the summaries that `receipt: "summary"` promised. */
@Cron({
  name: 'sweep-receipts',
  everyMs: EVERY,
  description: 'Summarises writes that asked for a receipt with one',
})
export class ReceiptsSweeper {
  constructor(private readonly worker: ReceiptWorker) {}

  async tick(): Promise<void> {
    // Keep draining while the queue outlasts a single bounded drain, up to one interval.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
