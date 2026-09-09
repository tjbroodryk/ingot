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
 * The write path: an arbitrary tool result becomes typed rows.
 *
 * Everything that can be refused is refused here, before anything is written —
 * a bad path, a value that will not coerce, a column whose type has changed.
 * That is the whole argument for declaring types in the mapping rather than
 * inferring them: the person who wrote the mapping is the person who can fix
 * it, and they are still holding the response.
 *
 * The row is queryable the moment this returns. It goes to the overlay, not to
 * Parquet, and a query unions the two — so there is no window where an agent
 * has stored something and cannot yet read it back.
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
    // Parsed before anything is written: a caller who asked for a receipt this
    // service cannot produce should be told so instead of storing the rows and
    // then failing on the way out.
    const receipt = ReceiptBuilder.kindOf(command.body.receipt);
    // The caller's own handle for this result. Trimmed and bounded here rather
    // than trusted, since the MCP surface builds this command without a pipe.
    const externalId = externalIdOf(command.body.externalId);
    const now = this.clock.now();

    // First write for a table is what creates it. There is no "create table"
    // endpoint on purpose: a schema declared separately from the data that
    // fills it is a schema that drifts from it.
    // Unconditional, and safe either way: a table this call just declared
    // already has exactly these columns and this key, so both are no-ops on it.
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

    // Hoisted rather than generated inline, because the receipt hands it back:
    // one `/add` is one batch, and that is what makes the rows retrievable as
    // a set afterwards.
    const batch = newIdValue('batch');
    const applied = mapping.apply(command.body.result, {
      rowId: () => newIdValue('row'),
      at: now,
      batch,
    });

    /*
     * The manifest is saved first, and only when it has something to say.
     *
     * If the overlay write then fails the whole command rolls back together,
     * so a schema that widened for rows that never landed is not a schema
     * anyone has to reason about.
     *
     * The condition is the important half. Saving unconditionally meant every
     * concurrent write to one table contended on its version — and the steady
     * state of this product is a stable schema with a great many rows, so that
     * was contention bought for nothing. A load test found it.
     */
    if (table.hasChanges) await this.tables.save(table);

    const queued = await this.overlay.append({
      ingotId: ingot.id.value,
      tableId: table.id.value,
      rows: applied.rows,
      embeddable: table.embeddedColumns.map((column) => column.name.value),
    });

    /*
     * The receipt is queued, never written here.
     *
     * Same argument as embedding and a stronger one: the written half is an
     * LLM call, which is seconds rather than milliseconds, and `/add` exists
     * to be fast. A caller asking for `receipt: "full"` is asking for
     * something to be findable later, not for this response to wait on it —
     * and the receipt hands back the SQL that collects it, so nothing is lost
     * by deferring.
     *
     * Inside the same transaction as the rows, so a queued receipt can never
     * describe a write that did not land.
     */
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

    // Told, rather than left to be found. See `background.ts`: a sweep every
    // minute was latency a caller experienced for no reason, since the work is
    // known about the instant it is queued. The tick stays as the floor.
    if (queued > 0) this.after(() => this.background.wakeEmbeddings());
    if (receipt === ReceiptKind.Full) this.after(() => this.background.wakeReceipts());

    return {
      table: table.name.value,
      rowsAdded: applied.rows.length,
      // Measured over what arrived, not over what was stored: a mapping
      // projects a blob into a few typed columns and throws the rest away, and
      // the number a caller wants is the size of the thing they were holding.
      payload: sizeOf(command.body.result),
      columnsAdded,
      queuedForEmbedding: queued,
      // Built after the write, so the schema it reports is the one the write
      // left behind — including any column this call introduced.
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
   * Wakes background work, after the rows are actually there.
   *
   * `afterCommit` is the whole of it. Waking from inside the transaction would
   * announce work that a rollback could still take away, and the worker would
   * go looking for a queue row that never existed — the port's own
   * documentation says anything with an effect outside this transaction belongs
   * here.
   *
   * `BackgroundWork.wake*` returns immediately and never throws: the rows are
   * committed and the caller's answer is already on its way, so a drain that
   * fails is latency rather than loss. The sweeper is the floor under it.
   */
  private after(wake: () => void): void {
    this.uow.afterCommit(async () => wake());
  }
}

/**
 * The caller's own id for this result, or null.
 *
 * Bounded rather than trusted: it is stored in a `VARCHAR` column and echoed
 * back in a receipt, and the MCP surface builds this command straight from a
 * tool call without passing through a validation pipe. Blank is treated as
 * absent, because a caller sending `""` meant to send nothing.
 */
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
