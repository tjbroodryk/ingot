import { Module } from '@nestjs/common';
import { IngotsModule } from '../ingots/ingots.module.js';
import { BackgroundWork } from './application/background.js';
import { AddRecordsHandler } from './application/commands/add-records.command.js';
import { ClaimDeliveryHandler } from './application/commands/claim-delivery.command.js';
import { ClaimReceiptHandler } from './application/commands/claim-receipt.command.js';
import { ClaimEmbeddingsHandler } from './application/commands/claim-embeddings.command.js';
import { CompactTableHandler } from './application/commands/compact-table.command.js';
import { CompleteDeliveryHandler } from './application/commands/complete-delivery.command.js';
import { DeleteRecordsHandler } from './application/commands/delete-records.command.js';
import { FailDeliveryHandler } from './application/commands/fail-delivery.command.js';
import { FailReceiptHandler } from './application/commands/fail-receipt.command.js';
import { ReleaseEmbeddingsHandler } from './application/commands/release-embeddings.command.js';
import { SaveEmbeddingsHandler } from './application/commands/save-embeddings.command.js';
import { WriteReceiptHandler } from './application/commands/write-receipt.command.js';
import { DeliveryWorker } from './application/delivery-worker.js';
import { ReceiptWorker } from './application/receipt-worker.js';
import { EmbedWorker } from './application/embed-worker.js';
import { DELIVERY_TRIGGER } from './application/ports/delivery-trigger.port.js';
import { RECEIPT_NOTIFIER } from './application/ports/receipt-notifier.port.js';
import { ReceiptBuilder } from './application/receipt-builder.js';
import { OutboxReceiptNotifier } from './infrastructure/outbox-receipt-notifier.js';
import { RecordsController } from './interface/records.controller.js';

/**
 * The write path, plus the three background workers that finish what it queued.
 *
 * The workers are services rather than commands on purpose: each is three
 * short transactions with a call to somebody else between them, and a command
 * is one transaction. `ReceiptWorker`, `EmbedWorker` and `DeliveryWorker` say
 * why at length; the short version is that `Dispatcher.send` would otherwise
 * hold a pooled connection for the length of an HTTP round trip.
 *
 * The three form a chain, and each link is a queue rather than a call: `/add`
 * queues a receipt, `ReceiptWorker` writes it and announces it into the outbox,
 * `DeliveryWorker` sends it. Every hand-off is a row committed with the work
 * that produced it, so nothing between them can be lost by a process dying.
 */
@Module({
  imports: [IngotsModule],
  controllers: [RecordsController],
  providers: [
    AddRecordsHandler,
    // `/add` wakes this on commit rather than leaving the work to be found on
    // the next tick — see `background.ts`.
    BackgroundWork,
    // The seam `WriteReceipt` wakes delivery through. A token rather than
    // `BackgroundWork` itself, because importing that from a command the
    // receipt worker dispatches would close an import cycle — the port says so.
    { provide: DELIVERY_TRIGGER, useExisting: BackgroundWork },
    DeleteRecordsHandler,
    CompactTableHandler,

    ClaimEmbeddingsHandler,
    SaveEmbeddingsHandler,
    ReleaseEmbeddingsHandler,
    EmbedWorker,

    ClaimReceiptHandler,
    WriteReceiptHandler,
    FailReceiptHandler,
    ReceiptWorker,

    // The outbox itself is bound in `OverlayModule` with the other queue
    // tables, because `ingots/` empties it when a memory is destroyed and
    // binding it here would make the two contexts import each other. These are
    // the things that drain it.
    ClaimDeliveryHandler,
    CompleteDeliveryHandler,
    FailDeliveryHandler,
    DeliveryWorker,

    ReceiptBuilder,
    OutboxReceiptNotifier,
    // The seam `WriteReceipt` calls, bound to the thing that writes a row
    // rather than the thing that makes a call — see the port for why those
    // cannot be the same object.
    { provide: RECEIPT_NOTIFIER, useExisting: OutboxReceiptNotifier },
  ],
  exports: [RECEIPT_NOTIFIER, ReceiptWorker, EmbedWorker, DeliveryWorker, BackgroundWork],
})
export class RecordsModule {}
