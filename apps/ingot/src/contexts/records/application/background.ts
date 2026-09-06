import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeliveryWorker } from './delivery-worker.js';
import type { Drained } from './drained.js';
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
 * How many drains of one kind may run at once.
 *
 * A `Record` over the enum, so a kind added without a bound fails to compile.
 * These are the only numbers in this file and each is a rate limit on somebody
 * else's service rather than on ours — the work itself is safe at any
 * concurrency, because a claim leases its rows and two drains take different
 * ones.
 *
 * **One is not the safe answer, and that is why these exist.** Serialised, a
 * write arriving at the start of a busy drain waits behind up to eight model
 * calls before its own batch is even claimed — latency somebody experiences as
 * a row that is not yet findable by meaning.
 *
 * The two model-backed queues are held low because the cost of getting it wrong
 * is a rate limit at a hosted provider and a bill. Deliveries are higher: a
 * delivery goes to a receiver the caller nominated, so ten concurrent ones are
 * ten different endpoints rather than ten calls at the same provider, and one
 * slow receiver must not hold up everybody else's.
 *
 * A deployment that has raised its provider's limits, or that runs a local
 * embedder, can afford more than this. Raise it here rather than reaching for
 * an environment variable: it is one number, and getting it wrong is visible in
 * `ingot_embeddings_pending` either way.
 */
export const CONCURRENCY: Record<BackgroundKind, number> = {
  [BackgroundKind.Embeddings]: 2,
  [BackgroundKind.Receipts]: 2,
  [BackgroundKind.Deliveries]: 6,
};

/**
 * The bound, injected rather than defaulted.
 *
 * A token and a real binding, because a constructor parameter with a default
 * is not optional to Nest: it reads `design:paramtypes`, sees four, and refuses
 * to resolve the fourth. Marking it `@Optional()` would hide that — and a
 * container that silently hands `undefined` to something whose whole job is a
 * limit is a limit that quietly becomes `NaN`.
 *
 * `RecordsModule` binds `CONCURRENCY`; a test passes its own positionally,
 * having constructed the class itself.
 */
export const BACKGROUND_CONCURRENCY = Symbol('BackgroundConcurrency');

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
 * `wake` below: wakes past `CONCURRENCY` collapse onto one trailing pass rather
 * than each starting a drain of its own.
 */
@Injectable()
export class BackgroundWork {
  private readonly logger = new Logger(BackgroundWork.name);

  /** What is draining now, per kind, so a wake can join rather than double it. */
  private readonly running = new Map<BackgroundKind, Set<Promise<void>>>();

  /** What was asked for while every slot was already taken. */
  private readonly again = new Set<BackgroundKind>();

  constructor(
    private readonly embeddings: EmbedWorker,
    private readonly receipts: ReceiptWorker,
    private readonly deliveries: DeliveryWorker,
    /**
     * `CONCURRENCY` in the service, and whatever a test pins. Injected rather
     * than read from the constant directly, so a test can describe the
     * mechanism without asserting on today's numbers.
     */
    @Inject(BACKGROUND_CONCURRENCY) private readonly limits: Record<BackgroundKind, number>,
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
   * Starts a drain if this kind has a slot, or notes that one more is owed.
   *
   * The bound is the point. A burst of writes would otherwise start a drain
   * each, and while that is *safe* — the claim leases its rows, so concurrent
   * drains take different work — it is an unbounded burst of concurrent calls
   * at whatever `INGOT_EMBEDDER` names, which is the one thing here worth being
   * careful with. `CONCURRENCY` says how many is deliberate.
   *
   * The trailing re-run covers two things, and both would otherwise wait out a
   * minute for the sweeper:
   *
   * - a wake that arrived with every slot taken, and
   * - a drain that stopped on its own bound with the queue still full, which
   *   `Drained.more` reports. Without that second one a backlog moved at one
   *   drain per sweep — `PASSES` was a rate limit rather than a yield point,
   *   and a single `/add` fanning out into thousands of rows got exactly one
   *   drain and then waited.
   *
   * One flag rather than a count, because a drain works until the queue is
   * empty or its bound is spent: what is owed is *a* pass, not one per wake.
   */
  private wake(key: BackgroundKind, drain: () => Promise<Drained>): void {
    let inFlight = this.running.get(key);
    if (!inFlight) {
      inFlight = new Set();
      this.running.set(key, inFlight);
    }

    if (inFlight.size >= this.limits[key]) {
      this.again.add(key);
      return;
    }

    const run = drain()
      .then((drained) => {
        // Booked here rather than in `finally`, so a drain that threw does not
        // chain: the sweeper is the floor under a failure, and re-running
        // immediately into a model that is down is a tight loop against it.
        if (drained.more) this.again.add(key);
      })
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
        // Assigned by the time this runs: promise callbacks are a microtask
        // away at the earliest, and the chain below is built synchronously.
        inFlight.delete(run);
        if (this.again.delete(key)) this.wake(key, drain);
      });

    inFlight.add(run);
  }

  /**
   * Waits for whatever is in flight. For tests and for shutdown, not for the
   * request path — the whole point of a wake is that nobody waits for it.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()].flatMap((inFlight) => [...inFlight]));
  }
}
