import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngotsModule } from '../ingots/ingots.module.js';
import {
  BACKGROUND_CONCURRENCY,
  type BackgroundKind,
  BackgroundWork,
} from './application/background.js';
import { concurrencyFrom } from './application/background-settings.js';
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
 * The workers are services, not commands: each is short transactions with a
 * network call between, which a single command's transaction cannot hold. They
 * chain through queues: `/add` → receipt → outbox → delivery.
 */
@Module({
  imports: [IngotsModule],
  controllers: [RecordsController],
  providers: [
    AddRecordsHandler,
    // `/add` wakes this on commit rather than leaving it for the sweep.
    BackgroundWork,
    // How many drains of one kind may run at once. A binding rather than a
    // default parameter, which Nest would refuse to resolve.
    {
      provide: BACKGROUND_CONCURRENCY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Record<BackgroundKind, number> => {
        const bounds = concurrencyFrom((key) => config.get<string>(key));
        announce(bounds);
        return bounds;
      },
    },
    // The seam `WriteReceipt` wakes delivery through. A token, not
    // `BackgroundWork` itself, to avoid an import cycle — see the port.
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

    // The outbox is bound in `OverlayModule` with the other queue tables, since
    // `ingots/` empties it when a memory is destroyed. These drain it.
    ClaimDeliveryHandler,
    CompleteDeliveryHandler,
    FailDeliveryHandler,
    DeliveryWorker,

    ReceiptBuilder,
    OutboxReceiptNotifier,
    // The seam `WriteReceipt` calls, bound to the thing that writes a row rather
    // than the thing that makes a call — see the port.
    { provide: RECEIPT_NOTIFIER, useExisting: OutboxReceiptNotifier },
  ],
  exports: [RECEIPT_NOTIFIER, ReceiptWorker, EmbedWorker, DeliveryWorker, BackgroundWork],
})
export class RecordsModule {}

/** Logs the per-kind drain concurrency at boot. */
function announce(bounds: Record<BackgroundKind, number>): void {
  const said = Object.entries(bounds)
    .map(([kind, limit]) => `${kind} ${limit}`)
    .join(', ');
  Logger.log(`Draining ${said} at a time, per replica`, 'Background');
}
