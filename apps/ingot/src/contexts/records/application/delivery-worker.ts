import { Inject, Injectable, Logger } from '@nestjs/common';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import {
  DELIVERY_TRANSPORT,
  type DeliveryTransport,
} from '../../../delivery/delivery-transport.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { errorMessage } from '../../../shared/error-message.js';
import { ClaimDelivery } from './commands/claim-delivery.command.js';
import { CompleteDelivery } from './commands/complete-delivery.command.js';
import { FailDelivery } from './commands/fail-delivery.command.js';
import type { Drained } from './drained.js';
import type { PendingDelivery } from './ports/delivery-outbox.port.js';

/**
 * Deliveries one drain will send. Larger than the receipt worker's, since these
 * are HTTP or AMQP sends rather than model calls; still bounded so one pass
 * cannot run forever against a slow receiver.
 */
const PASSES = 32;

/**
 * Sends one announced receipt: claim, deliver, record the outcome. A service,
 * not a command: `Dispatcher.send` wraps each command in a transaction, so the
 * receiver is called between commands with no connection held.
 *
 * ```
 * ClaimDelivery     tx ~1ms    leases the row, counts the attempt
 *   transport.deliver         no transaction, no connection
 * CompleteDelivery  tx ~1ms    out of the outbox
 * ```
 *
 * Never call from inside a command, or the three dispatches join that
 * transaction. `WriteReceipt` wakes it through `BackgroundWork`; the sweeper
 * calls `drain` directly.
 */
@Injectable()
export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(DELIVERY_TRANSPORT) private readonly transport: DeliveryTransport,
    @Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings,
  ) {}

  /** Sends until the outbox is empty or the pass is spent. */
  async drain(): Promise<Drained> {
    let sent = 0;
    let more = false;

    for (let pass = 0; pass < PASSES; pass++) {
      // Nothing claimed: empty, all leased, or all out of attempts — nothing to
      // gain from asking again.
      if (!(await this.next())) break;
      sent++;
      // Work on the last pass means the outbox outlasted this drain; start another now.
      more = pass === PASSES - 1;
    }

    if (sent > 0) this.logger.log(`Delivered ${sent} receipt${sent === 1 ? '' : 's'}`);
    return { done: sent, more };
  }

  /** Whether there was work. False means the outbox is empty or all leased. */
  async next(): Promise<boolean> {
    const job: PendingDelivery | null = await this.dispatcher.send(
      new ClaimDelivery(this.settings.maxAttempts),
    );
    if (!job) return false;

    const started = performance.now();
    try {
      // `attempt` is the row's, not the payload's: the body was rendered when
      // the receipt was written. A receiver uses it to tell whether it has seen
      // this batch before.
      await this.transport.deliver(job.target, { ...job.payload, attempt: job.attempts });
      await this.dispatcher.send(new CompleteDelivery(job.batch));
      this.measure(job, Outcome.Ok, started);
    } catch (error) {
      this.measure(job, Outcome.Error, started);
      await this.dispatcher.send(
        new FailDelivery(job.batch, job.attempts, this.settings.maxAttempts, errorMessage(error)),
      );
    }
    return true;
  }

  /**
   * The whole attempt, not just the call. Labelled by transport, not endpoint:
   * `kind` is a closed set, an endpoint would be an unbounded label carrying a
   * caller's URL into the metrics.
   */
  private measure(job: PendingDelivery, outcome: Outcome, started: number): void {
    Metrics.DeliveryDuration.observe(
      { kind: job.target.t, outcome },
      (performance.now() - started) / 1000,
    );
  }
}
