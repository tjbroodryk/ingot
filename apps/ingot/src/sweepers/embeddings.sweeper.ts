import { Logger } from '@nestjs/common';
import type { Context } from '@restatedev/restate-sdk';
import { EMBED_BATCH } from '../contexts/records/application/commands/claim-embeddings.command.js';
import { EMBEDDING_SERVICE } from '../contexts/records/application/background.js';
import { EmbedWorker } from '../contexts/records/application/embed-worker.js';
import { RestateCron, RestateHandler, minutes, scheduleNextTick } from '../restate/index.js';

const EVERY = minutes(1);

/** Batches per pass. Bounded so a large backlog is worked, not swallowed. */
const PER_PASS = 8;

/**
 * Embeds whatever `/add` queued — on being told, and on a timer.
 *
 * Two ways in, and they matter for different reasons.
 *
 * `now` is the fast path: `/add` sends here the moment its transaction
 * commits, so a row becomes findable by meaning in about as long as the model
 * takes rather than in up to a minute. That minute was latency a caller
 * experienced for no reason — the work was known about the instant it was
 * queued.
 *
 * `tick` is the floor, and is not redundant. It covers the send that never
 * went: `/add` sends from `uow.afterCommit`, which swallows a failure by
 * design because the rows are already committed, and the send is not
 * journalled, so a process that dies between the COMMIT and the POST loses it
 * with no trace either. Both entry points call the same worker, so there is
 * one implementation of "embed what is waiting" and no way for the two paths
 * to disagree.
 *
 * Neither has to care about the other arriving at once. The claim leases its
 * rows with `FOR UPDATE SKIP LOCKED`, so a triggered pass and a tick running
 * together take different work rather than the same work twice.
 *
 * Silent when nothing moved, which is what keeps a per-write trigger and a
 * once-a-minute timer out of the log.
 */
@RestateCron({
  name: EMBEDDING_SERVICE,
  everyMs: EVERY,
  description: 'Embeds overlay rows whose text has no vector yet',
})
export class EmbeddingsSweeper {
  private readonly logger = new Logger(EmbeddingsSweeper.name);

  constructor(private readonly worker: EmbedWorker) {}

  /** Told by `/add` that there is work. Books no next tick — the chain is separate. */
  @RestateHandler()
  async now(ctx: Context): Promise<void> {
    await this.drain(ctx);
  }

  @RestateHandler()
  async tick(ctx: Context): Promise<void> {
    await this.drain(ctx);
    await scheduleNextTick(ctx, this);
  }

  /**
   * One pass over the queue.
   *
   * Shared by both entry points rather than written twice, so that "how much
   * one pass does" is a single decision. `ctx.run` journals each batch, so a
   * pass retried by Restate does not re-embed what it already stored.
   */
  private async drain(ctx: Context): Promise<void> {
    let embedded = 0;

    for (let pass = 0; pass < PER_PASS; pass++) {
      const done: number = await ctx.run(`embed batch ${pass}`, () =>
        this.worker.next(EMBED_BATCH),
      );
      embedded += done;
      // A short batch means the queue is empty; stop rather than spending the
      // rest of the pass asking again.
      if (done < EMBED_BATCH) break;
    }

    if (embedded > 0) this.logger.log(`Embedded ${embedded} rows`);
  }
}
