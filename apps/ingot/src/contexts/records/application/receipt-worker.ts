import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAX_BODY_CHARS, SUMMARISER, type Summariser, clamp } from '../../../ai/summariser.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { errorMessage } from '../../../shared/error-message.js';
import { ClaimReceipt, type ClaimedReceipt } from './commands/claim-receipt.command.js';
import type { Drained } from './drained.js';
import { FailReceipt } from './commands/fail-receipt.command.js';
import { WriteReceipt } from './commands/write-receipt.command.js';

/** Receipts one drain will write. Small, since each is an LLM call. */
const PASSES = 4;

/**
 * Writes one receipt: claim, ask a model, store the answer. A service, not a
 * command: `Dispatcher.send` wraps each command in a transaction, so the model
 * is asked between commands with no connection held.
 *
 * ```
 * ClaimReceipt   tx ~1ms    leases the row, counts the attempt
 *   summarise              no transaction, no connection
 * WriteReceipt   tx ~2ms    the ingot_receipts row, and out of the queue
 * ```
 *
 * Never call from inside a command, or the three dispatches join that
 * transaction. The sweeper calls it directly.
 */
@Injectable()
export class ReceiptWorker {
  private readonly logger = new Logger(ReceiptWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(SUMMARISER) private readonly summariser: Summariser,
  ) {}

  /**
   * Works the queue until it is empty or the pass is spent. Called by the
   * sweeper and by `/add` when a write commits. The bound is small because each
   * receipt is an LLM call.
   */
  async drain(): Promise<Drained> {
    let written = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      // Nothing claimed: empty, all leased, or all out of attempts — nothing to
      // gain from asking again.
      if (!(await this.next())) break;
      written++;
      // Work on the last pass means the queue outlasted this drain; start another now.
      more = pass === PASSES - 1;
    }

    if (written > 0) this.logger.log(`Wrote ${written} receipt${written === 1 ? '' : 's'}`);
    return { done: written, more };
  }

  /** Whether there was work. False means the queue is empty or all leased. */
  async next(): Promise<boolean> {
    const job: ClaimedReceipt | null = await this.dispatcher.send(new ClaimReceipt());
    if (!job) return false;

    const body = clamp(render(job.body), MAX_BODY_CHARS);
    const started = performance.now();

    try {
      const receipt = await this.summariser.summarise({
        table: job.sourceTable,
        columns: job.columns,
        rows: job.rows,
        body,
      });

      await this.dispatcher.send(new WriteReceipt(job, receipt, body, this.summariser.model));
      this.measure(Outcome.Ok, started);
    } catch (error) {
      this.measure(Outcome.Error, started);
      await this.dispatcher.send(
        new FailReceipt(job.batch, job.sourceTable, job.attempts, errorMessage(error)),
      );
    }
    return true;
  }

  /**
   * The whole attempt, not just the model call: spans the write too, so the
   * metric is how long a receipt takes to become findable.
   */
  private measure(outcome: Outcome, started: number): void {
    Metrics.ReceiptDuration.observe(
      { model: this.summariser.model, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/**
 * The tool result as text, pretty-printed rather than compact: a language model
 * reads it, and indentation is how the nesting survives truncation.
 */
function render(body: unknown): string {
  try {
    return JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    // Circular, or a BigInt. Neither arrives over HTTP, but the MCP surface
    // builds this command from a tool call without a parse.
    return String(body);
  }
}
