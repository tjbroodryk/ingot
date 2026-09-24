import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../ports/delivery-outbox.port.js';

/**
 * Sent: the row leaves the outbox. A command so it is one measured transaction
 * on a connection taken after the network call. Deliberately last — a row
 * deleted before confirmation would be a delivery believed made but not.
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
