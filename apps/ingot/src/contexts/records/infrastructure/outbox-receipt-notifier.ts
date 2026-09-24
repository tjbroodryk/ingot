import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DeliveredReceipt, DeliveryEvent } from '@ingot/shared/ingot-v1';
import { INGOT_REPOSITORY, IngotId, type IngotRepository } from '../../ingots/domain/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';
import type { ReceiptNotifier, ReceiptReady } from '../application/ports/receipt-notifier.port.js';

/**
 * Writes the intention to deliver, in the transaction that wrote the receipt.
 * Target and payload are resolved and stored here, so an in-flight delivery is
 * not retargeted. A memory with no delivery configured enqueues nothing.
 */
@Injectable()
export class OutboxReceiptNotifier implements ReceiptNotifier {
  private readonly logger = new Logger(OutboxReceiptNotifier.name);

  constructor(
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
  ) {}

  async ready(receipt: ReceiptReady): Promise<void> {
    const ingot = await this.ingots.findById(IngotId.of(receipt.ingotId));

    // A memory destroyed between the queue and the summariser: nothing to
    // deliver to, and the receipt row is going the same way.
    if (!ingot?.delivery.configured) {
      this.logger.debug(
        `Receipt ready for ${receipt.batch} on "${receipt.sourceTable}" ` +
          `(${receipt.model}): ${receipt.searchTerm}`,
      );
      return;
    }

    await this.outbox.enqueue({
      batch: receipt.batch,
      ingotId: receipt.ingotId,
      target: ingot.delivery.toWire(),
      payload: bodyOf(receipt),
      queuedAt: receipt.readyAt,
    });
  }
}

/**
 * The receipt as a receiver sees it. `attempt` is 1 here and rewritten by the
 * worker on the way out, since whether this is a redelivery is a property of the
 * delivery, not the receipt.
 */
function bodyOf(receipt: ReceiptReady): DeliveredReceipt {
  return {
    event: DeliveryEvent.ReceiptReady,
    ingot: receipt.ingotId,
    batch: receipt.batch,
    externalId: receipt.externalId,
    sourceTable: receipt.sourceTable,
    summary: receipt.summary,
    searchTerm: receipt.searchTerm,
    totalResults: receipt.rows,
    query: receipt.query,
    model: receipt.model,
    readyAt: receipt.readyAt.toISOString(),
    attempt: 1,
  };
}
