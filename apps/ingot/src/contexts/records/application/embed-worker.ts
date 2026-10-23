import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMBEDDER, type Embedder } from '../../../ai/embedder.port.js';
import { rateLimitWaitMs } from '../../../ai/remote.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../shared/domain/index.js';
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
 *   embed                      no transaction, no connection, ≤16k tokens a request
 * SaveEmbeddings    tx ~5ms    that request's vectors, and out of the queue
 * ```
 *
 * Never call it from inside a command: `PgUnitOfWork.run` joins an open
 * transaction rather than nesting, so the three dispatches would land back
 * inside the one this exists to avoid.
 */
@Injectable()
export class EmbedWorker {
  private readonly logger = new Logger(EmbedWorker.name);

  /** Epoch ms before which no drain calls the model: set by a rate limit. */
  private pausedUntil = 0;

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(CLOCK) private readonly clock: Clock,
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
    // Asking again inside the window only extends it; the next sweep after it comes back.
    if (this.clock.now().getTime() < this.pausedUntil) return { done: 0, more: false };

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

  /**
   * How many rows were embedded. Zero means the queue is empty or all leased.
   *
   * The claim is sent to the model in requests of at most `EMBED_REQUEST_TOKENS`
   * (`packByTokens`), each saved as it returns. A request that fails hands back
   * itself and everything after it, not what already succeeded.
   */
  async next(limit: number = EMBED_BATCH): Promise<number> {
    const pending: readonly PendingEmbedding[] = await this.dispatcher.send(
      new ClaimEmbeddings(limit),
    );
    if (pending.length === 0) return 0;

    const requests = packByTokens(pending, EMBED_REQUEST_TOKENS);
    let saved = 0;
    for (const [at, request] of requests.entries()) {
      const started = performance.now();
      let vectors: number[][];
      try {
        vectors = await this.embedder.embed(request.map((entry) => entry.text));
      } catch (error) {
        this.measure(Outcome.Error, started);
        // Handed back rather than dropped: a model that is down is a model that
        // will be up, and the next tick tries again. Dropping the work here
        // would leave a column permanently and silently empty.
        await this.dispatcher.send(new ReleaseEmbeddings(requests.slice(at).flat()));
        // `drain` logs its total only when it finishes, and this throw is how a
        // rate-limited drain ends: without this line its progress is invisible.
        if (saved > 0) this.logger.log(`Embedded ${saved} rows before the embedder failed`);
        this.backOff(error);
        throw error;
      }
      this.measure(Outcome.Ok, started);
      saved += await this.save(request, vectors);
    }
    return saved;
  }

  /** A rate limit stops every drain in this process until the host's window has passed. */
  private backOff(error: unknown): void {
    const wait = rateLimitWaitMs(error);
    if (wait === null) return;
    this.pausedUntil = this.clock.now().getTime() + wait;
    this.logger.warn(
      `Embedding paused for ${Math.round(wait / 1000)}s: the embedder is rate limited`,
    );
  }

  private async save(pending: readonly PendingEmbedding[], vectors: number[][]): Promise<number> {
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
    // vectors comparable, and the ingot records both.
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

/**
 * The most one embedding request may carry, in estimated tokens.
 *
 * A request bigger than the provider's per-minute budget can never succeed:
 * an Azure deployment at 120k TPM refuses a 64-text batch of 2k-token diffs
 * every time, and the queue stops for good. Small requests fit any sensible
 * quota and get through a minute's budget a piece at a time.
 */
export const EMBED_REQUEST_TOKENS = 16_000;

/**
 * Tokens, overestimated from UTF-8 bytes. A token is rarely under three bytes
 * of code or prose, and never under one; counting exactly would mean
 * tokenising every text for a limit that only needs to be safe.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/** In order, into runs of at most `budget` estimated tokens; a text over budget goes alone. */
export function packByTokens<T extends { readonly text: string }>(
  entries: readonly T[],
  budget: number,
): T[][] {
  const requests: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const entry of entries) {
    const size = estimateTokens(entry.text);
    if (current.length > 0 && tokens + size > budget) {
      requests.push(current);
      current = [];
      tokens = 0;
    }
    current.push(entry);
    tokens += size;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}
