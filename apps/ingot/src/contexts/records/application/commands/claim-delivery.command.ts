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
 * Takes one announced receipt, leases it, and hands it over to be sent.
 *
 * The first of three, and the split is `ReceiptWorker`'s, for the same reason.
 * A delivery is claimed, somebody else's endpoint or broker is called, and the
 * outcome is written — with the transaction held for only the first and the
 * last. Doing all three in one command would keep a Postgres connection for the
 * length of an HTTP round trip to a receiver we do not control, and there are
 * ten in the pool: a receiver that takes ten seconds to answer would starve the
 * requests this service exists to answer, while looking like a database problem.
 *
 * `DeliveryWorker` is what runs the three in order.
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
