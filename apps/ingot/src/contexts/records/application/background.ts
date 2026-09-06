import { Injectable, Logger } from '@nestjs/common';
import { DeliveryWorker } from './delivery-worker.js';
import { EmbedWorker } from './embed-worker.js';
import { ReceiptWorker } from './receipt-worker.js';

/**
 * The queues `/add` can fill and therefore the ones it can wake.
 *
 * Named rather than stringly typed because the harness asserts on them: what a
 * write told the background is a property worth holding, and a write that
 * queues embedding work and wakes nothing has silently lost the fast path — the
 * only evidence being a row that stays unembedded for up to a minute in
 * production and for ever in a test.
 */
export enum BackgroundKind {
  Embeddings = 'embeddings',
  Receipts = 'receipts',
  /**
   * Receipts announced to a memory's delivery target and not yet sent.
   *
   * Woken by the receipt's own write rather than by `/add`, because that is
   * when there is something to deliver — a receipt is queued at `/add` and
   * becomes findable a model call later.
   */
  Deliveries = 'deliveries',
}

/**
 * The work `/add` sets off the moment it commits.
 *
 * **A delivery is the fast path and a sweep is the floor** — the rule
 * `CLAUDE.md` gives webhooks, applied to our own writes. A row that has just
 * been stored should be embedded now, not within a minute, because that minute
 * is latency a caller experiences: they store something and it is not findable
 * by meaning until a timer happens to fire.
 *
 * So `/add` wakes the worker here, and the sweeper on its timer stays exactly
 * as it was. The sweep is not redundant — it is the floor under a wake that
 * never happened, and there are two ways for that: the process can die between
 * the COMMIT and this call, and a drain can throw half-way through a backlog.
 * Both leave queue rows behind with nobody told about them, and the next tick
 * finds them. Both paths call the same `drain`, so they cannot disagree about
 * what the work is.
 *
 * Rolling the overlay up into Parquet is deliberately **not** here. That one is
 * genuinely periodic: its whole value is amortising a file rewrite over many
 * rows, and triggering it per write would produce a generation per `/add` —
 * the opposite of what a compaction is for.
 *
 * This used to be a one-way call into Restate, with the batch id as an
 * idempotency key to collapse duplicate sends. In-process, the equivalent is
 * `wake` below: a second wake while a drain is running does not start a second
 * drain.
 */
@Injectable()
export class BackgroundWork {
  private readonly logger = new Logger(BackgroundWork.name);

  /** What is draining now, so a wake can join it rather than double it. */
  private readonly running = new Map<BackgroundKind, Promise<void>>();

  /** What was asked for while a drain was already going. */
  private readonly again = new Set<BackgroundKind>();

  constructor(
    private readonly embeddings: EmbedWorker,
    private readonly receipts: ReceiptWorker,
    private readonly deliveries: DeliveryWorker,
  ) {}

  /** Embeds what was just queued, without making the caller wait for it. */
  wakeEmbeddings(): void {
    this.wake(BackgroundKind.Embeddings, () => this.embeddings.drain());
  }

  /** Writes the receipts that were just promised. */
  wakeReceipts(): void {
    this.wake(BackgroundKind.Receipts, () => this.receipts.drain());
  }

  /**
   * Sends the receipts that were just announced.
   *
   * Called from `WriteReceipt`'s `afterCommit` rather than from `/add`: a
   * receipt is queued at `/add` and does not exist until a model has answered,
   * so waking delivery any earlier would be a drain over an empty queue.
   */
  wakeDeliveries(): void {
    this.wake(BackgroundKind.Deliveries, () => this.deliveries.drain());
  }

  /**
   * Starts a drain, or notes that one more is owed when the current one ends.
   *
   * The coalescing is the point. A burst of writes would otherwise start a
   * drain each, and while that is *safe* — the claim leases its rows, so
   * concurrent drains take different work — it is a burst of concurrent calls
   * at whatever model `INGOT_EMBEDDER` names, which is the one thing here worth
   * being careful with.
   *
   * The trailing re-run is what stops a wake being lost: a row queued just
   * after a drain read the queue and just before it finished would otherwise
   * wait for the sweeper. One more pass costs an empty query when there is
   * nothing there.
   */
  private wake(key: BackgroundKind, drain: () => Promise<number>): void {
    if (this.running.has(key)) {
      this.again.add(key);
      return;
    }

    const run = drain()
      .then(() => undefined)
      .catch((error: unknown) => {
        /*
         * Logged and swallowed, which is the right severity.
         *
         * Nothing is waiting on this: the caller's rows are committed and their
         * response has been sent. The queue still holds the work and the
         * sweeper is the floor under exactly this case, so a failure here costs
         * latency and not data. Throwing would be an unhandled rejection in a
         * detached promise, which is a way to take a process down over work
         * that was already covered.
         */
        this.logger.warn(
          `Waking ${key} failed: ${error instanceof Error ? error.message : String(error)}. ` +
            'The sweeper will pick it up.',
        );
      })
      .finally(() => {
        this.running.delete(key);
        if (this.again.delete(key)) this.wake(key, drain);
      });

    this.running.set(key, run);
  }

  /**
   * Waits for whatever is in flight. For tests and for shutdown, not for the
   * request path — the whole point of a wake is that nobody waits for it.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
}
