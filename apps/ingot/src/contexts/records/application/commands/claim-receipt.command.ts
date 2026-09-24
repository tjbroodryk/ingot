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
 * How many times a model is asked about one tool result before giving up. Low:
 * the non-transient failures repeat exactly.
 */
export const MAX_RECEIPT_ATTEMPTS = 4;

/** A claimed receipt, and enough of the source schema to prompt a model with. */
export interface ClaimedReceipt extends PendingReceipt {
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

/**
 * Takes one queued receipt, leases it, and hands it over. First of three steps
 * run by `ReceiptWorker`; the connection is given back before the model is
 * asked, and the lease stops a second worker taking the same row.
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
   * The source table's schema, so a summary can name real fields. Best effort:
   * a table dropped between `/add` and this tick does not abandon the receipt.
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
