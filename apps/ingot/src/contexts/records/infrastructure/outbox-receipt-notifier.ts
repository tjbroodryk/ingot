import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DeliveredReceipt, DeliveryEvent } from '@ingot/shared/ingot-v1';
import { INGOT_REPOSITORY, IngotId, type IngotRepository } from '../../ingots/domain/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';
import type { ReceiptNotifier, ReceiptReady } from '../application/ports/receipt-notifier.port.js';

/**
 * Writes the intention to deliver, in the transaction that wrote the receipt.
 *
 * Two decisions worth stating, because both are about what happens when
 * somebody changes their mind halfway through.
 *
 * **The target is resolved here, and stored on the row.** A memory whose
 * endpoint is changed while a delivery is queued should not have that delivery
 * silently retargeted at the new one: the row records where it was going when
 * the promise was made. It also means the worker never has to load an
 * aggregate, which is what keeps it three short transactions.
 *
 * **The payload is rendered here too**, rather than rebuilt when the delivery
 * goes out. Rebuilding would mean re-reading rows a tombstone or a roll-up may
 * have moved since, and a delivery should say what was true when the receipt
 * landed — not what is true whenever a receiver happens to come back up.
 *
 * A memory with no delivery configured enqueues nothing at all. That is the
 * default and the overwhelming majority: the receipt's own SELECT is the
 * contract, and writing an outbox row for a target that is `none` would be a
 * queue that fills up as fast as receipts are written and drains into a log
 * line.
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

    // Null is not reachable through `/add` — the receipt was queued against a
    // memory that existed — but a memory destroyed between the queue and the
    // summariser is. Nothing to deliver to and nothing to complain about: the
    // receipt row is going the same way.
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
 * The receipt as a receiver sees it.
 *
 * `attempt` is 1 here and rewritten by the worker on the way out, because it is
 * the one field that is a property of the *delivery* rather than of the receipt
 * — a receiver reading it wants to know whether this is a redelivery, and the
 * row cannot know that until it is claimed.
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
