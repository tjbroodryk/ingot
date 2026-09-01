import { Injectable, Logger } from '@nestjs/common';
import type { ReceiptNotifier, ReceiptReady } from '../application/ports/receipt-notifier.port.js';

/**
 * The default: a debug line, and nothing leaves the process.
 *
 * A no-op adapter rather than an optional dependency, so `SummariseNext` has
 * one code path instead of a null check — and so the thing a webhook adapter
 * has to implement is visible and bound from the day the port exists.
 *
 * Debug rather than log because a memory under load produces a receipt per
 * `/add` that asked for one, and an info line each would drown the log for a
 * fact nobody is waiting on. The receipt itself is queryable; this is only for
 * somebody watching the sweeper work.
 */
@Injectable()
export class LoggingReceiptNotifier implements ReceiptNotifier {
  private readonly logger = new Logger(LoggingReceiptNotifier.name);

  async ready(receipt: ReceiptReady): Promise<void> {
    this.logger.debug(
      `Receipt ready for ${receipt.batch} on "${receipt.sourceTable}" ` +
        `(${receipt.model}): ${receipt.searchTerm}`,
    );
  }
}
