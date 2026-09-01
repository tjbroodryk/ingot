import { ReceiptWorker } from '../contexts/records/application/receipt-worker.js';
import { Cron, minutes } from './cron.js';

const EVERY = minutes(1);

/**
 * Writes the summaries that `receipt: "summary"` promised.
 *
 * The same two ways in as the embedding sweeper, for the same reasons. `/add`
 * wakes the worker on commit, so a caller who was handed a SELECT and told it
 * would fill in gets it filled in about as fast as the model answers; this tick
 * is the floor under a wake that never arrived.
 *
 * Nothing here is a second write path: `ReceiptWorker` is the only thing in the
 * service that produces a receipt, and both ways in call its `drain`.
 * Concurrent arrivals are safe because a claim takes a lease — a woken pass and
 * a tick take different rows rather than describing the same result twice.
 */
@Cron({
  name: 'sweep-receipts',
  everyMs: EVERY,
  description: 'Summarises writes that asked for a receipt with one',
})
export class ReceiptsSweeper {
  constructor(private readonly worker: ReceiptWorker) {}

  async tick(): Promise<void> {
    await this.worker.drain();
  }
}
