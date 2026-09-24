import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { Receipt } from '../../../../ai/summariser.port.js';
import {
  Command,
  type ICommandHandler,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import { DELIVERY_TRIGGER, type DeliveryTrigger } from '../ports/delivery-trigger.port.js';
import { CLOCK, type Clock, newIdValue } from '../../../../shared/domain/index.js';
import {
  BATCH,
  INGESTED_AT,
  type IngotTable,
  ROW_ID,
} from '../../../ingots/domain/index.js';
import { TableRegistry } from '../../../ingots/application/table-registry.js';
import type { Coerced } from '../../domain/coercion.js';
import {
  RECEIPT_BATCH,
  RECEIPT_EXTERNAL_ID,
  RECEIPT_BODY,
  RECEIPT_MODEL,
  RECEIPT_ROWS,
  RECEIPT_SEARCH_TERM,
  RECEIPT_SOURCE_TABLE,
  RECEIPT_SUMMARY,
  RECEIPT_TABLE,
  declareReceiptTable,
  queryForReceipt,
} from '../../domain/receipt-table.js';
import { RECEIPT_NOTIFIER, type ReceiptNotifier } from '../ports/receipt-notifier.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingReceipt,
} from '../ports/overlay-store.port.js';

/**
 * Stores a receipt a model has already written. The last of three; the model
 * was asked outside any transaction so this one is short — create the table on
 * first receipt, append the row, leave the queue.
 */
export class WriteReceipt extends Command<void> {
  constructor(
    readonly job: PendingReceipt,
    readonly receipt: Receipt,
    /** The tool result as the model saw it: rendered and already truncated. */
    readonly body: string,
    readonly model: string,
  ) {
    super();
  }
}

@CommandHandler(WriteReceipt)
export class WriteReceiptHandler implements ICommandHandler<WriteReceipt> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    private readonly registry: TableRegistry,
    @Inject(RECEIPT_NOTIFIER) private readonly notifier: ReceiptNotifier,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(DELIVERY_TRIGGER) private readonly background: DeliveryTrigger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: WriteReceipt): Promise<void> {
    const { job, receipt } = command;
    const table = await this.receiptTable(job.ingotId);
    const now = this.clock.now();

    const row: Record<string, Coerced> = {
      [ROW_ID]: newIdValue('row'),
      [INGESTED_AT]: now.toISOString(),
      // Its own batch: this write is not the caller's. `source_batch` ties the
      // two together and is what a receipt's query is keyed on.
      [BATCH]: newIdValue('batch'),
      [RECEIPT_BATCH]: job.batch,
      [RECEIPT_EXTERNAL_ID]: job.externalId,
      [RECEIPT_SOURCE_TABLE]: job.sourceTable,
      [RECEIPT_SUMMARY]: receipt.summary,
      [RECEIPT_SEARCH_TERM]: receipt.searchTerm,
      [RECEIPT_BODY]: command.body,
      [RECEIPT_ROWS]: job.rows,
      [RECEIPT_MODEL]: command.model,
    };

    // Through the ordinary overlay, which is the point of making
    // `ingot_receipts` a table: embeddings are queued, the roll-up folds them
    // into Parquet, and `/query` unions the tiers, none of it written twice.
    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows: [row],
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });

    await this.overlay.completeReceipt(job.batch);

    // Announced inside the transaction that wrote it: the notifier writes an
    // outbox row rather than calling anybody, so the receipt and the promise to
    // announce it land together. Implementations must not throw.
    await this.notifier.ready({
      ingotId: job.ingotId,
      batch: job.batch,
      externalId: job.externalId,
      sourceTable: job.sourceTable,
      summary: receipt.summary,
      searchTerm: receipt.searchTerm,
      rows: job.rows,
      query: queryForReceipt(job.batch),
      model: command.model,
      readyAt: now,
    });

    // Sent afterwards, via `afterCommit`: a wake inside the transaction would
    // send the worker after an outbox row a rollback could remove. The sweeper
    // is the floor under a wake that never happened.
    this.uow.afterCommit(async () => this.background.wakeDeliveries());
  }

  /** The memory's receipt table, creating it on the first receipt. */
  private async receiptTable(ingotId: string): Promise<IngotTable> {
    return this.registry.ensureCurrent(ingotId, RECEIPT_TABLE, () =>
      declareReceiptTable(ingotId, this.clock.now()),
    );
  }
}
