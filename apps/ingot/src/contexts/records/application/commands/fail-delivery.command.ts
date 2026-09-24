import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../ports/delivery-outbox.port.js';

/** Max length of the failure reason kept on the row. */
const MAX_REASON_CHARS = 500;

/**
 * Records why a delivery failed and releases the lease early. Does not count
 * the attempt — the claim already did, so a worker killed mid-delivery cannot
 * leave the count stuck at zero.
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
      // Loud, and only once: the data is fine — the summary is written and
      // still queryable; only the telling was lost.
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
