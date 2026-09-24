import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { type AddBody, type AddResult, ReceiptKind } from '@ingot/shared/ingot-v1';
import {
  CLOCK,
  type Clock,
  InvariantViolation,
  newIdValue,
} from '../../../../shared/domain/index.js';
import {
  Command,
  type ICommandHandler,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import { BackgroundWork } from '../background.js';
import { Metrics, Outcome } from '../../../../observability/index.js';
import {
  INGOT_TABLE_REPOSITORY,
  IngotTable,
  type IngotTableRepository,
} from '../../../ingots/domain/index.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { TableRegistry } from '../../../ingots/application/table-registry.js';
import { sizeOf } from '../../domain/payload-size.js';
import { RowMapping } from '../../domain/row-mapping.vo.js';
import { ReceiptBuilder } from '../receipt-builder.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

/** `POST /api/v1/:account/:ingot/add` */
export class AddRecords extends Command<AddResult> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly body: AddBody,
  ) {
    super();
  }
}

/**
 * The write path: an arbitrary tool result becomes typed rows, with everything
 * refusable refused before anything is written. Rows land in the overlay (not
 * Parquet) and are queryable the moment this returns.
 */
@CommandHandler(AddRecords)
export class AddRecordsHandler implements ICommandHandler<AddRecords> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    private readonly registry: TableRegistry,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly receipts: ReceiptBuilder,
    private readonly background: BackgroundWork,
  ) {}

  async execute(command: AddRecords): Promise<AddResult> {
    try {
      return await this.write(command);
    } catch (error) {
      Metrics.RowsIngested.inc({ outcome: Outcome.Error }, 0);
      throw error;
    }
  }

  private async write(command: AddRecords): Promise<AddResult> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);
    const mapping = RowMapping.parse(command.body);
    // Parsed up front, so an unsupported receipt kind is refused before rows are stored.
    const receipt = ReceiptBuilder.kindOf(command.body.receipt);
    // The caller's handle for this result; bounded here since the MCP surface
    // builds this command without a validation pipe.
    const externalId = externalIdOf(command.body.externalId);
    const now = this.clock.now();

    // First write for a table creates it; there is no separate create-table
    // step. Unconditional and safe: an existing table already has these columns
    // and key, so both are no-ops on it.
    const table = await this.registry.ensure(ingot.id.value, mapping.table, () =>
      IngotTable.declare({
        ingotId: ingot.id.value,
        name: mapping.table,
        columns: mapping.columns,
        key: mapping.key,
        raw: mapping.raw,
        now,
      }),
    );
    table.assertKeyUnchanged(mapping.key);
    const columnsAdded = table.accommodate(mapping.columns);

    // One `/add` is one batch; hoisted because the receipt hands it back, which
    // is what makes the rows retrievable as a set.
    const batch = newIdValue('batch');
    const applied = mapping.apply(command.body.result, {
      rowId: () => newIdValue('row'),
      at: now,
      batch,
    });

    // Manifest saved first and only when changed, so a rollback of the overlay
    // write also unwinds a schema that widened for rows that never landed. The
    // condition keeps concurrent writes to a stable-schema table off its version.
    if (table.hasChanges) await this.tables.save(table);

    const queued = await this.overlay.append({
      ingotId: ingot.id.value,
      tableId: table.id.value,
      rows: applied.rows,
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });

    // The receipt is queued, never written here: the written half is an LLM
    // call and `/add` exists to be fast. Queued in the same transaction as the
    // rows, so it can never describe a write that did not land.
    if (receipt === ReceiptKind.Full) {
      await this.overlay.queueReceipt({
        batch,
        externalId,
        ingotId: ingot.id.value,
        tableId: table.id.value,
        sourceTable: table.name.value,
        body: command.body.result,
        rows: applied.rows.length,
        queuedAt: now,
      });
    }

    Metrics.RowsIngested.inc({ outcome: Outcome.Ok }, applied.rows.length);

    // Woken rather than left for the sweep; the tick stays as the floor.
    if (queued > 0) this.after(() => this.background.wakeEmbeddings());
    if (receipt === ReceiptKind.Full) this.after(() => this.background.wakeReceipts());

    return {
      table: table.name.value,
      rowsAdded: applied.rows.length,
      // Measured over what arrived, not what was stored: the mapping keeps only some columns.
      payload: sizeOf(command.body.result),
      columnsAdded,
      queuedForEmbedding: queued,
      // Built after the write, so the reported schema includes any column this call added.
      ...maybe(
        await this.receipts.build({
          kind: receipt,
          table,
          batch,
          externalId,
          rows: applied.rows,
        }),
      ),
    };
  }

  /**
   * Wakes background work after the rows are committed. `afterCommit` only:
   * waking inside the transaction would announce work a rollback could remove.
   * The wake returns immediately and never throws.
   */
  private after(wake: () => void): void {
    this.uow.afterCommit(async () => wake());
  }
}

/** Max length of the caller's external id; bounded since it is stored and echoed back. */
const MAX_EXTERNAL_ID = 200;

function externalIdOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_EXTERNAL_ID) {
    throw new InvariantViolation(
      `externalId is ${trimmed.length} characters; at most ${MAX_EXTERNAL_ID}. It is meant to ` +
        'be your handle for this result, not the result.',
    );
  }
  return trimmed;
}

/** Omits the key entirely rather than sending `receipt: undefined`. */
function maybe(receipt: AddResult['receipt']): Pick<AddResult, 'receipt'> | undefined {
  return receipt ? { receipt } : undefined;
}
