import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { INGOT_TABLE_REPOSITORY, type IngotTableRepository } from '../../../ingots/domain/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingReceipt,
} from '../ports/overlay-store.port.js';

/**
 * How many times a model is asked about one tool result before we stop.
 *
 * Low, because the failures worth retrying are transient and the ones that are
 * not repeat exactly: a body the model will not summarise, a response that is
 * never JSON, a safety filter. `remote.ts` has already absorbed the single
 * retry that fixes a rate limit, so each of these is a genuinely fresh attempt
 * some ticks apart.
 */
export const MAX_RECEIPT_ATTEMPTS = 4;

/** A claimed receipt, and enough of the source schema to prompt a model with. */
export interface ClaimedReceipt extends PendingReceipt {
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

/**
 * Takes one queued receipt, leases it, and hands it over.
 *
 * The first of three, and the split is the point. A receipt is claimed, a model
 * is asked, and the answer is written — with the transaction held for only the
 * first and the last. Doing all three in one command would keep a Postgres
 * connection for the length of an LLM call, and there are ten in the pool: a
 * few concurrent receipts would starve the requests this service exists to
 * answer, while looking like a database problem.
 *
 * So the connection is given back before the model is asked, and a lease on
 * the row is what stops a second worker taking the same one. `ReceiptWorker`
 * is what runs the three in order.
 */
export class ClaimReceipt extends Command<ClaimedReceipt | null> {}

@CommandHandler(ClaimReceipt)
export class ClaimReceiptHandler implements ICommandHandler<ClaimReceipt> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<ClaimedReceipt | null> {
    const pending = await this.overlay.claimReceipt(MAX_RECEIPT_ATTEMPTS, this.clock.now());
    if (!pending) return null;

    return { ...pending, columns: await this.schemaOf(pending) };
  }

  /**
   * The source table's schema, so a summary can name real fields.
   *
   * Read here rather than by the worker because it is a read of the same rows
   * the claim just touched, and because the worker should hold nothing but
   * what it needs to ask a question. Best effort: a table dropped between the
   * `/add` and this tick is not a reason to abandon the receipt — the body is
   * still there and is most of what the model reads.
   */
  private async schemaOf(
    pending: PendingReceipt,
  ): Promise<readonly { name: string; type: string }[]> {
    const table = await this.tables.findByName(pending.ingotId, pending.sourceTable);
    return (table?.columns ?? [])
      .filter((column) => !column.name.value.startsWith('_'))
      .map((column) => ({ name: column.name.value, type: column.type }));
  }
}
