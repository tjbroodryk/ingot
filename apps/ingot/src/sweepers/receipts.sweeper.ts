import { Logger } from '@nestjs/common';
import type { Context } from '@restatedev/restate-sdk';
import { RECEIPT_SERVICE } from '../contexts/records/application/background.js';
import { ReceiptWorker } from '../contexts/records/application/receipt-worker.js';
import { RestateCron, RestateHandler, minutes, scheduleNextTick } from '../restate/index.js';

const EVERY = minutes(1);

/**
 * Receipts per pass.
 *
 * Small, because each one is an LLM call and a backlog is better worked across
 * passes than in one long run. It is a bound on spend and on how long a pass
 * takes, not on the connection pool — `ReceiptWorker` hands its transaction
 * back before the model is asked. `ingot_receipts_pending` says whether it is
 * keeping up.
 */
const PER_PASS = 4;

/**
 * Writes the summaries that `receipt: "summary"` promised.
 *
 * The same two ways in as the embedding sweeper, for the same reasons. `/add`
 * sends to `now` on commit, so a caller who was handed a SELECT and told it
 * would fill in gets it filled in about as fast as the model answers. `tick`
 * is the floor that covers a send which never arrived.
 *
 * Nothing here is a second write path: `ReceiptWorker` is the only thing in the
 * service that produces a receipt, and both handlers call it. Concurrent
 * arrivals are safe because a claim takes a lease — a triggered pass and a
 * tick take different rows rather than describing the same result twice.
 */
@RestateCron({
  name: RECEIPT_SERVICE,
  everyMs: EVERY,
  description: 'Summarises writes that asked for a receipt with one',
})
export class ReceiptsSweeper {
  private readonly logger = new Logger(ReceiptsSweeper.name);

  constructor(private readonly worker: ReceiptWorker) {}

  /** Told by `/add` that there is work. Books no next tick. */
  @RestateHandler()
  async now(ctx: Context): Promise<void> {
    await this.drain(ctx);
  }

  @RestateHandler()
  async tick(ctx: Context): Promise<void> {
    await this.drain(ctx);
    await scheduleNextTick(ctx, this);
  }

  private async drain(ctx: Context): Promise<void> {
    let written = 0;

    for (let pass = 0; pass < PER_PASS; pass++) {
      // Journalled per receipt rather than per pass, so a pass that dies
      // halfway does not ask a model to describe the same result twice on the
      // retry — the ones already done replay from the journal.
      const found: boolean = await ctx.run(`receipt ${pass}`, () => this.worker.next());
      // Nothing claimed means the queue is empty, everything left is leased by
      // another worker, or everything left has run out of attempts. All three
      // are the same answer: there is nothing to gain from asking again.
      if (!found) break;
      written++;
    }

    if (written > 0) this.logger.log(`Wrote ${written} receipt${written === 1 ? '' : 's'}`);
  }
}
