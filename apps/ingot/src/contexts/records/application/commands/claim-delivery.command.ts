import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import {
  DELIVERY_OUTBOX,
  type DeliveryOutbox,
  type PendingDelivery,
} from '../ports/delivery-outbox.port.js';

/**
 * Takes one announced receipt, leases it, and hands it over to be sent. First
 * of three steps run by `DeliveryWorker`; the claim and the write hold a
 * transaction, the call to the receiver does not.
 */
export class ClaimDelivery extends Command<PendingDelivery | null> {
  constructor(readonly maxAttempts: number) {
    super();
  }
}

@CommandHandler(ClaimDelivery)
export class ClaimDeliveryHandler implements ICommandHandler<ClaimDelivery> {
  constructor(
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(command: ClaimDelivery): Promise<PendingDelivery | null> {
    return this.outbox.claim(command.maxAttempts, this.clock.now());
  }
}
