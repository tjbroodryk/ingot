import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { MAX_RECEIPT_ATTEMPTS } from './claim-receipt.command.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

/** How much of a model's complaint is worth keeping on the row. */
const MAX_REASON_CHARS = 500;

/**
 * Records why a receipt did not get written, and hands the row back early.
 *
 * It does **not** count the attempt — the claim already did, which is what
 * makes the count trustworthy. A worker killed by the very body it was
 * describing never gets here at all, so a counter incremented in this command
 * would sit at zero while that body was retried for ever.
 *
 * What it does instead is release the lease. A model that failed a second ago
 * is worth asking again on the next tick, and waiting out five minutes of
 * lease for work already known to have failed is five minutes of nothing.
 */
export class FailReceipt extends Command<void> {
  constructor(
    readonly batch: string,
    readonly sourceTable: string,
    readonly attempts: number,
    readonly reason: string,
  ) {
    super();
  }
}

@CommandHandler(FailReceipt)
export class FailReceiptHandler implements ICommandHandler<FailReceipt> {
  private readonly logger = new Logger(FailReceiptHandler.name);

  constructor(@Inject(OVERLAY_STORE) private readonly overlay: OverlayStore) {}

  async execute(command: FailReceipt): Promise<void> {
    const reason = command.reason.slice(0, MAX_REASON_CHARS);
    await this.overlay.failReceipt(command.batch, reason);

    if (command.attempts >= MAX_RECEIPT_ATTEMPTS) {
      // Loud, and only once. The caller was handed a query that will now stay
      // empty, and nothing else in the system will ever mention it again —
      // except `ingot_receipts_abandoned`, which is why that gauge exists.
      this.logger.error(
        `Giving up on the receipt for ${command.batch} on "${command.sourceTable}" after ` +
          `${command.attempts} attempts: ${reason}`,
      );
      return;
    }
    this.logger.warn(
      `Receipt for ${command.batch} failed (attempt ${command.attempts}): ${reason}`,
    );
  }
}
