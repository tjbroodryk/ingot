import { Inject, Injectable } from '@nestjs/common';
import { MAX_BODY_CHARS, SUMMARISER, type Summariser, clamp } from '../../../ai/summariser.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { ClaimReceipt, type ClaimedReceipt } from './commands/claim-receipt.command.js';
import { FailReceipt } from './commands/fail-receipt.command.js';
import { WriteReceipt } from './commands/write-receipt.command.js';

/**
 * Writes one receipt: claim, ask a model, store the answer.
 *
 * **This is a service and not a command, and that is the whole design.**
 * `Dispatcher.send` opens a Postgres transaction around every command, which
 * is exactly right when a command is the unit of change — and exactly wrong
 * for work with a network call in the middle of it. A single `SummariseReceipt`
 * command would hold one of ten pooled connections for the length of an LLM
 * call, so a handful of concurrent receipts would starve the requests this
 * service exists to answer, and it would look like a database problem.
 *
 * So the unit of change is three commands and this is what runs them in order.
 * Nothing here touches Postgres directly; each step is dispatched, measured
 * and transactional on its own, and the model is asked in between with no
 * connection held at all.
 *
 * ```
 * ClaimReceipt   tx ~1ms    leases the row, counts the attempt
 *   summarise              no transaction, no connection
 * WriteReceipt   tx ~2ms    the ingot_receipts row, and out of the queue
 * ```
 *
 * There is a precedent for the shape: `TurnReconciler` in `@forge/api` does
 * its own I/O and then applies what it found through the same command an event
 * would have. A service that orchestrates commands is fine; a service that
 * writes rows behind their back is not, and this one does not.
 *
 * It must never be called from inside a command, or the three dispatches join
 * that transaction and the whole point is lost — `PgUnitOfWork.run` joins
 * rather than nests. The sweeper calls it directly, which is why the sweeper
 * does not dispatch it.
 */
@Injectable()
export class ReceiptWorker {
  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(SUMMARISER) private readonly summariser: Summariser,
  ) {}

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
        new FailReceipt(job.batch, job.sourceTable, job.attempts, message(error)),
      );
    }
    return true;
  }

  /**
   * The whole attempt, not just the model call.
   *
   * Deliberately spans the write too: what somebody watching this wants to
   * know is how long a receipt takes to become findable, and the model is only
   * most of that.
   */
  private measure(outcome: Outcome, started: number): void {
    Metrics.ReceiptDuration.observe(
      { model: this.summariser.model, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/**
 * The tool result as text.
 *
 * Pretty-printed rather than compact, because what reads it is a language
 * model: indentation and line breaks are how the nesting survives, and a
 * single-line blob truncated at 8,000 characters loses the structure before it
 * loses the content.
 */
function render(body: unknown): string {
  try {
    return JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    // Circular, or a BigInt. Neither can arrive over HTTP, but the MCP surface
    // builds this command from a tool call and does not pass through a parse.
    return String(body);
  }
}

function message(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}
