import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../ports/delivery-outbox.port.js';

/** How much of a receiver's complaint is worth keeping on the row. */
const MAX_REASON_CHARS = 500;

/**
 * Records why a delivery did not go out, and hands the row back early.
 *
 * It does **not** count the attempt — the claim already did, which is what
 * makes the count trustworthy. A worker killed by the very delivery it was
 * making never gets here at all, so a counter incremented in this command
 * would sit at zero while that row was retried for ever.
 *
 * What it does instead is release the lease. A receiver that answered 503 a
 * second ago is worth trying again on the next sweep, and waiting out five
 * minutes of lease for work already known to have failed is five minutes of a
 * receiver being told nothing after it came back up.
 */
export class FailDelivery extends Command<void> {
  constructor(
    readonly batch: string,
    readonly attempts: number,
    readonly maxAttempts: number,
    readonly reason: string,
  ) {
    super();
  }
}

@CommandHandler(FailDelivery)
export class FailDeliveryHandler implements ICommandHandler<FailDelivery> {
  private readonly logger = new Logger(FailDeliveryHandler.name);

  constructor(@Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox) {}

  async execute(command: FailDelivery): Promise<void> {
    const reason = command.reason.slice(0, MAX_REASON_CHARS);
    await this.outbox.fail(command.batch, reason);

    if (command.attempts >= command.maxAttempts) {
      // Loud, and only once. Somebody configured a target and will now never
      // hear about this receipt — and unlike an abandoned *receipt*, the data
      // is fine: the summary is written and the SELECT the caller was handed
      // still returns it. What was lost is the telling.
      this.logger.error(
        `Giving up on delivering ${command.batch} after ${command.attempts} attempts: ` +
          `${reason}. The receipt is written and still queryable; nobody was told.`,
      );
      return;
    }
    this.logger.warn(
      `Delivery of ${command.batch} failed (attempt ${command.attempts}): ${reason}`,
    );
  }
}
