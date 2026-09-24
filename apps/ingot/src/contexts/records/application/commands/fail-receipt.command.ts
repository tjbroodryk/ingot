import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { MAX_RECEIPT_ATTEMPTS } from './claim-receipt.command.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

/** Max length of the failure reason kept on the row. */
const MAX_REASON_CHARS = 500;

/**
 * Records why a receipt failed and releases the lease early. Does not count the
 * attempt — the claim already did, so a worker killed mid-write cannot leave
 * the count stuck at zero.
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
      // Loud, and only once: the caller's query will now stay empty and nothing
      // else mentions it, except the `ingot_receipts_abandoned` gauge.
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
