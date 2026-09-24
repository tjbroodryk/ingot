import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../../shared/error-message.js';
import { FileWorker } from '../../files/application/file-worker.js';
import { DeliveryWorker } from './delivery-worker.js';
import type { Drained } from './drained.js';
import { EmbedWorker } from './embed-worker.js';
import { ReceiptWorker } from './receipt-worker.js';

/** The queues `/add` can fill and therefore the ones it can wake. */
export enum BackgroundKind {
  Embeddings = 'embeddings',
  Receipts = 'receipts',
  /** Receipts announced to a delivery target and not yet sent. */
  Deliveries = 'deliveries',
  /** Documents accepted by `/file` and not yet read. */
  Files = 'files',
}

/**
 * Default concurrency per kind. A `Record` over the enum, so a kind added
 * without a bound fails to compile.
 */
export const CONCURRENCY: Record<BackgroundKind, number> = {
  [BackgroundKind.Embeddings]: 2,
  [BackgroundKind.Receipts]: 2,
  [BackgroundKind.Deliveries]: 6,
  // Bounded by heap, not a remote rate limit: a parse holds the whole document
  // in memory (zip and PDF do not stream).
  [BackgroundKind.Files]: 2,
};

/** Injection token for the per-kind concurrency bounds. */
export const BACKGROUND_CONCURRENCY = Symbol('BackgroundConcurrency');

/**
 * Runs the work `/add` sets off the moment it commits, so a just-stored row is
 * worked now rather than at the next sweep. The sweeper remains the floor under
 * a wake that never fired.
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
    // From the global `FileStoreModule`, which breaks the import cycle with `/file`.
    private readonly files: FileWorker,
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

  /** Sends the receipts that were just announced; called from `WriteReceipt`'s `afterCommit`. */
  wakeDeliveries(): void {
    this.wake(BackgroundKind.Deliveries, () => this.deliveries.drain());
  }

  /** Reads the documents `/file` has just accepted. */
  wakeFiles(): void {
    this.wake(BackgroundKind.Files, () => this.files.drain());
  }

  /**
   * Starts a drain if this kind has a slot, otherwise notes one more is owed.
   * One flag rather than a count: a drain works until the queue is empty or its
   * bound is spent, so what is owed is a pass, not one per wake.
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
        // Booked here, not in `finally`, so a drain that threw does not
        // immediately chain into another.
        if (drained.more) this.again.add(key);
      })
      .catch((error: unknown) => {
        // Logged and swallowed: nothing awaits this, the queue keeps the work,
        // and the sweeper covers it. Throwing would be an unhandled rejection
        // in a detached promise.
        this.logger.warn(
          `Waking ${key} failed: ${errorMessage(error)}. ` +
            'The sweeper will pick it up.',
        );
      })
      .finally(() => {
        // `run` is assigned by now: callbacks are a microtask away and the
        // chain is built synchronously.
        inFlight.delete(run);
        if (this.again.delete(key)) this.wake(key, drain);
      });

    inFlight.add(run);
  }

  /** Waits for whatever is in flight; for shutdown, not the request path. */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()].flatMap((inFlight) => [...inFlight]));
  }
}
