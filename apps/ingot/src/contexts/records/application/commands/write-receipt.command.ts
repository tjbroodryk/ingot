import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { Receipt } from '../../../../ai/summariser.port.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  CLOCK,
  type Clock,
  ConflictingState,
  newIdValue,
} from '../../../../shared/domain/index.js';
import {
  BATCH,
  INGESTED_AT,
  INGOT_TABLE_REPOSITORY,
  type IngotTable,
  type IngotTableRepository,
  ROW_ID,
} from '../../../ingots/domain/index.js';
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
 * Stores a receipt a model has already written.
 *
 * The last of three, and it takes the answer rather than fetching it: the
 * model was asked outside any transaction, precisely so that this one is short.
 * Everything here is Postgres — create the table if this is the memory's first
 * receipt, append the row, leave the queue — and it is measured as its own
 * command, so "receipts are slow" resolves into which of the three is slow.
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
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(RECEIPT_NOTIFIER) private readonly notifier: ReceiptNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: WriteReceipt): Promise<void> {
    const { job, receipt } = command;
    const table = await this.receiptTable(job.ingotId);
    const now = this.clock.now();

    const row: Record<string, Coerced> = {
      [ROW_ID]: newIdValue('row'),
      [INGESTED_AT]: now.toISOString(),
      // Its own batch: this write is not the caller's write. `source_batch` is
      // what ties the two together, and what a receipt's query is keyed on.
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

    // Through the ordinary overlay, which is the whole point of making
    // `ingot_receipts` a table: this queues the three embeddings, the roll-up folds
    // them into Parquet, and `/query` unions the tiers — none of it written
    // twice for receipts.
    await this.overlay.append({
      ingotId: job.ingotId,
      tableId: table.id.value,
      rows: [row],
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });

    await this.overlay.completeReceipt(job.batch);

    // Announced inside the transaction that wrote it, so the port says
    // implementations must not throw: a notifier that failed would unwind a
    // summary a model has already been paid for. The only one today logs.
    await this.notifier.ready({
      ingotId: job.ingotId,
      batch: job.batch,
      sourceTable: job.sourceTable,
      summary: receipt.summary,
      searchTerm: receipt.searchTerm,
      query: queryForReceipt(job.batch),
      model: command.model,
    });
  }

  /**
   * The memory's receipt table, creating it on the first receipt.
   *
   * Same race as `/add` creating a table, handled the same way and for the
   * same reason: the id is derived from `(ingot, name)`, so two workers
   * colliding lose on the primary key rather than on a unique index — an
   * ordinary version miss, with a table now sitting there to be re-read.
   */
  private async receiptTable(ingotId: string): Promise<IngotTable> {
    const existing = await this.tables.findByName(ingotId, RECEIPT_TABLE);
    if (existing) return existing;

    const declared = declareReceiptTable(ingotId, this.clock.now());
    try {
      await this.tables.save(declared);
      return declared;
    } catch (error) {
      if (!(error instanceof ConflictingState)) throw error;

      const winner = await this.tables.findByName(ingotId, RECEIPT_TABLE);
      if (!winner) throw error; // Lost the race to something that then vanished.
      return winner;
    }
  }
}
