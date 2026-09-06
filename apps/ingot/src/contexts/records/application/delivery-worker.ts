import { Inject, Injectable, Logger } from '@nestjs/common';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import {
  DELIVERY_TRANSPORT,
  type DeliveryTransport,
} from '../../../delivery/delivery-transport.port.js';
import { Metrics, Outcome } from '../../../observability/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { ClaimDelivery } from './commands/claim-delivery.command.js';
import { CompleteDelivery } from './commands/complete-delivery.command.js';
import { FailDelivery } from './commands/fail-delivery.command.js';
import type { PendingDelivery } from './ports/delivery-outbox.port.js';

/**
 * Deliveries one drain will send.
 *
 * Larger than the receipt worker's four, because these are not model calls:
 * one is an HTTP POST or an AMQP publish, and a memory under load produces one
 * per receipt. Still bounded, so one pass cannot run for ever against a
 * receiver that is slow but not failing.
 */
const PASSES = 32;

/**
 * Sends one announced receipt: claim, deliver, record the outcome.
 *
 * **This is a service and not a command, and it is the same argument
 * `ReceiptWorker` makes at length.** `Dispatcher.send` opens a Postgres
 * transaction around every command, which is right when a command is the unit
 * of change and wrong for work with a network call in the middle. A single
 * `SendDelivery` command would hold one of ten pooled connections for as long
 * as somebody else's webhook took to answer — so a handful of concurrent
 * deliveries to a slow receiver would starve the requests this service exists
 * to answer, and it would look like a database problem.
 *
 * So the unit of change is three commands and this is what runs them in order.
 * Nothing here touches Postgres directly; each step is dispatched, measured and
 * transactional on its own, and the receiver is called in between with no
 * connection held at all.
 *
 * ```
 * ClaimDelivery     tx ~1ms    leases the row, counts the attempt
 *   transport.deliver         no transaction, no connection
 * CompleteDelivery  tx ~1ms    out of the outbox
 * ```
 *
 * It must never be called from inside a command, or the three dispatches join
 * that transaction and the whole point is lost — `PgUnitOfWork.run` joins
 * rather than nests. `WriteReceipt` wakes it through `BackgroundWork` on
 * commit, and the sweeper calls `drain` directly.
 */
@Injectable()
export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(DELIVERY_TRANSPORT) private readonly transport: DeliveryTransport,
    @Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings,
  ) {}

  /**
   * Sends until the outbox is empty or the pass is spent.
   *
   * The one implementation of "deliver what has been announced", called by the
   * sweeper on its timer and by `WriteReceipt` the moment a receipt commits —
   * so a receiver hears about a receipt about as fast as the model wrote it,
   * rather than within the minute.
   */
  async drain(): Promise<number> {
    let sent = 0;

    for (let pass = 0; pass < PASSES; pass++) {
      // Nothing claimed means the outbox is empty, everything left is leased by
      // another worker, or everything left has run out of attempts. All three
      // are the same answer: there is nothing to gain from asking again.
      if (!(await this.next())) break;
      sent++;
    }

    if (sent > 0) this.logger.log(`Delivered ${sent} receipt${sent === 1 ? '' : 's'}`);
    return sent;
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
      // the receipt was written and could not know this. A receiver reading it
      // wants to know whether it has seen this batch before.
      await this.transport.deliver(job.target, { ...job.payload, attempt: job.attempts });
      await this.dispatcher.send(new CompleteDelivery(job.batch));
      this.measure(job, Outcome.Ok, started);
    } catch (error) {
      this.measure(job, Outcome.Error, started);
      await this.dispatcher.send(
        new FailDelivery(job.batch, job.attempts, this.settings.maxAttempts, message(error)),
      );
    }
    return true;
  }

  /**
   * The whole attempt, not just the call.
   *
   * Labelled by transport rather than by memory or endpoint: `kind` is a closed
   * set of three, and an endpoint would be an unbounded label carrying a
   * caller's URL — possibly with a token in it — into the metrics.
   */
  private measure(job: PendingDelivery, outcome: Outcome, started: number): void {
    Metrics.DeliveryDuration.observe(
      { kind: job.target.t, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

function message(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}
