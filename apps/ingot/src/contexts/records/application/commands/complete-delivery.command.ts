import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../ports/delivery-outbox.port.js';

/**
 * Sent: the row leaves the outbox.
 *
 * A command rather than a call from the worker, so that it is one transaction,
 * measured under its own name, on a connection taken after the network call
 * gave one back. "Deliveries are slow" then resolves into which of the three
 * steps is slow, rather than into a single number that is mostly somebody
 * else's latency.
 *
 * It is deliberately the *last* thing that happens. A row deleted before the
 * confirmation came back would be a delivery this service believes it made.
 */
export class CompleteDelivery extends Command {
  constructor(readonly batch: string) {
    super();
  }
}

@CommandHandler(CompleteDelivery)
export class CompleteDeliveryHandler implements ICommandHandler<CompleteDelivery> {
  constructor(@Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox) {}

  execute(command: CompleteDelivery): Promise<void> {
    return this.outbox.complete(command.batch);
  }
}
