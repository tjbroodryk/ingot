import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMBEDDER, type Embedder } from '../../../ai/embedder.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { ClaimEmbeddings, EMBED_BATCH } from './commands/claim-embeddings.command.js';
import type { Drained } from './drained.js';
import { ReleaseEmbeddings } from './commands/release-embeddings.command.js';
import { type EmbeddedText, SaveEmbeddings } from './commands/save-embeddings.command.js';
import type { PendingEmbedding } from './ports/overlay-store.port.js';

/** Batches one drain will work. Bounded so a large backlog is worked, not swallowed. */
const PASSES = 8;

/**
 * Embeds one batch: claim, call the model, store the vectors. A service, not a
 * command: `Dispatcher.send` wraps each command in a transaction, so a single
 * command that claimed and embedded would hold a pooled connection across the
 * embedder call.
 *
 * ```
 * ClaimEmbeddings   tx ~1ms    leases up to 128 texts
 *   embed                      no transaction, no connection
 * SaveEmbeddings    tx ~5ms    the vectors, and out of the queue
 * ```
 *
 * Never call from inside a command: `PgUnitOfWork.run` joins an open transaction
 * rather than nesting.
 */
@Injectable()
export class EmbedWorker {
  private readonly logger = new Logger(EmbedWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /**
   * Works the queue until it is empty or the pass is spent. Called by the
   * sweeper and by `/add` when a write commits. Two passes at once is safe: the
   * claim leases with `FOR UPDATE SKIP LOCKED`.
   */
  async drain(): Promise<Drained> {
    let embedded = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      const done = await this.next();
      embedded += done;
      // A short batch means the queue is empty; stop.
      if (done < EMBED_BATCH) break;
      // A full batch on the last pass means the queue outlasted this drain; see `Drained`.
      more = pass === PASSES - 1;
    }

    if (embedded > 0) this.logger.log(`Embedded ${embedded} rows`);
    return { done: embedded, more };
  }

  /** How many rows were embedded. Zero means the queue is empty or all leased. */
  async next(limit: number = EMBED_BATCH): Promise<number> {
    const pending: readonly PendingEmbedding[] = await this.dispatcher.send(
      new ClaimEmbeddings(limit),
    );
    if (pending.length === 0) return 0;

    const started = performance.now();
    let vectors: number[][];
    try {
      vectors = await this.embedder.embed(pending.map((entry) => entry.text));
    } catch (error) {
      this.measure(Outcome.Error, started);
      // Handed back rather than dropped, so the next tick retries; dropping
      // would leave a column silently empty.
      await this.dispatcher.send(new ReleaseEmbeddings(pending));
      throw error;
    }
    this.measure(Outcome.Ok, started);

    const embedded = pending.flatMap<EmbeddedText>((entry, at) => {
      const vector = vectors[at];
      // Fewer vectors than texts: skip the unpaired rows so no text gets the
      // wrong vector; the release below requeues them.
      return vector ? [{ ...entry, vector }] : [];
    });

    const short = pending.filter((_entry, at) => vectors[at] === undefined);
    if (short.length > 0) {
      this.logger.warn(
        `Embedder returned ${vectors.length} vectors for ${pending.length} texts — ` +
          `${short.length} rows go back on the queue`,
      );
      await this.dispatcher.send(new ReleaseEmbeddings(short));
    }

    // The space, not just the model name: dimensions are part of what makes two
    // vectors comparable.
    return this.dispatcher.send(
      new SaveEmbeddings(embedded, {
        model: this.embedder.model,
        dimensions: this.embedder.dimensions,
      }),
    );
  }

  private measure(outcome: Outcome, started: number): void {
    Metrics.EmbeddingDuration.observe(
      { model: this.embedder.model, outcome },
      (performance.now() - started) / 1000,
    );
  }
}
