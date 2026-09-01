import { Module } from '@nestjs/common';
import { IngotsModule } from '../ingots/ingots.module.js';
import { BackgroundWork } from './application/background.js';
import { AddRecordsHandler } from './application/commands/add-records.command.js';
import { ClaimReceiptHandler } from './application/commands/claim-receipt.command.js';
import { ClaimEmbeddingsHandler } from './application/commands/claim-embeddings.command.js';
import { CompactTableHandler } from './application/commands/compact-table.command.js';
import { DeleteRecordsHandler } from './application/commands/delete-records.command.js';
import { FailReceiptHandler } from './application/commands/fail-receipt.command.js';
import { ReleaseEmbeddingsHandler } from './application/commands/release-embeddings.command.js';
import { SaveEmbeddingsHandler } from './application/commands/save-embeddings.command.js';
import { WriteReceiptHandler } from './application/commands/write-receipt.command.js';
import { ReceiptWorker } from './application/receipt-worker.js';
import { EmbedWorker } from './application/embed-worker.js';
import { RECEIPT_NOTIFIER } from './application/ports/receipt-notifier.port.js';
import { ReceiptBuilder } from './application/receipt-builder.js';
import { LoggingReceiptNotifier } from './infrastructure/logging-receipt-notifier.js';
import { RecordsController } from './interface/records.controller.js';

/**
 * The write path, plus the two background workers that finish what it queued.
 *
 * The workers are services rather than commands on purpose: each is three
 * short transactions with a call to somebody else's model between them, and a
 * command is one transaction. `ReceiptWorker` and `EmbedWorker` say why at
 * length; the short version is that `Dispatcher.send` would otherwise hold a
 * pooled connection for the length of an HTTP round trip.
 */
@Module({
  imports: [IngotsModule],
  controllers: [RecordsController],
  providers: [
    AddRecordsHandler,
    // `/add` wakes this on commit rather than leaving the work to be found on
    // the next tick — see `background.ts`.
    BackgroundWork,
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

    ReceiptBuilder,
    LoggingReceiptNotifier,
    // A no-op by default rather than an optional dependency, so the handler
    // has one path and a webhook adapter has one binding to replace.
    { provide: RECEIPT_NOTIFIER, useExisting: LoggingReceiptNotifier },
  ],
  exports: [RECEIPT_NOTIFIER, ReceiptWorker, EmbedWorker, BackgroundWork],
})
export class RecordsModule {}
