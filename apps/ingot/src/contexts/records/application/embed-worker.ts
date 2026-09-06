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
 * Embeds one batch: claim, call the model, store the vectors.
 *
 * The same shape as `ReceiptWorker` and for the same reason. `Dispatcher.send`
 * opens a transaction around every command, so a single command that claimed
 * *and* embedded would hold one of ten pooled connections across an HTTP round
 * trip to OpenAI or Vertex — a background job taking the foreground with it.
 *
 * That was invisible for as long as the only embedder ran in-process and
 * finished in microseconds. It stops being invisible the moment somebody sets
 * `INGOT_EMBEDDER`, which is what makes this worth splitting now rather than
 * when the graphs get strange.
 *
 * ```
 * ClaimEmbeddings   tx ~1ms    leases up to 128 texts
 *   embed                      no transaction, no connection
 * SaveEmbeddings    tx ~5ms    the vectors, and out of the queue
 * ```
 *
 * Never call it from inside a command: `PgUnitOfWork.run` joins an open
 * transaction rather than nesting, so the three dispatches would land back
 * inside the one this exists to avoid.
 */
@Injectable()
export class EmbedWorker {
  private readonly logger = new Logger(EmbedWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /**
   * Works the queue until it is empty or the pass is spent.
   *
   * The one implementation of "embed what is waiting", called by the sweeper on
   * its timer and by `/add` the moment a write commits. It lives here rather
   * than in the sweeper so those two cannot come to disagree about what a pass
   * is — and because "how much work to do in one go" is a property of the work,
   * not of what woke it up.
   *
   * Two passes arriving at once is safe and is expected: the claim leases its
   * rows with `FOR UPDATE SKIP LOCKED`, so they take different work rather than
   * the same work twice.
   */
  async drain(): Promise<Drained> {
    let embedded = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      const done = await this.next();
      embedded += done;
      // A short batch means the queue is empty; stop rather than spending the
      // rest of the pass asking again.
      if (done < EMBED_BATCH) break;
      // A full batch on the last pass means the queue outlasted this drain.
      // Saying so is what gets another one booked immediately rather than at
      // the next sweep — see `Drained`.
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
      // Handed back rather than dropped: a model that is down is a model that
      // will be up, and the next tick tries again. Dropping the work here
      // would leave a column permanently and silently empty.
      await this.dispatcher.send(new ReleaseEmbeddings(pending));
      throw error;
    }
    this.measure(Outcome.Ok, started);

    const embedded = pending.flatMap<EmbeddedText>((entry, at) => {
      const vector = vectors[at];
      // A model that returned fewer vectors than texts is a model behaving
      // badly; skipping the mismatch pairs nobody's text with somebody else's
      // vector, and the release below puts those rows back.
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

    // The space, not just the model name: the width is half of what makes two
    // vectors comparable, and the memory records both.
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
