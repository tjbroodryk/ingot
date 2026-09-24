import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Metrics } from '../../../observability/index.js';
import { MAX_RECEIPT_ATTEMPTS } from '../application/commands/claim-receipt.command.js';
import { OVERLAY_STORE, type OverlayStore } from '../application/ports/overlay-store.port.js';

/**
 * Gauges for whether the background is keeping up. Here rather than with the
 * pool collector since they count rows in this context's tables. Read at scrape
 * time rather than incremented, since an incremented gauge drifts.
 */
@Injectable()
export class OverlayCollectors implements OnApplicationBootstrap {
  private readonly logger = new Logger(OverlayCollectors.name);

  constructor(@Inject(OVERLAY_STORE) private readonly overlay: OverlayStore) {}

  onApplicationBootstrap(): void {
    Metrics.OverlayRows.collectWith(async (gauge) => {
      await this.safely('overlay depth', async () => gauge.set({}, await this.overlay.totalRows()));
    });

    Metrics.EmbeddingsPending.collectWith(async (gauge) => {
      await this.safely('pending embeddings', async () =>
        gauge.set({}, await this.overlay.pendingCount()),
      );
    });

    Metrics.ReceiptsPending.collectWith(async (gauge) => {
      await this.safely('pending receipts', async () =>
        gauge.set({}, await this.overlay.receiptsPending(MAX_RECEIPT_ATTEMPTS)),
      );
    });

    // Kept apart from the pending count: an abandoned receipt is not a backlog
    // that will clear. Summed in, a growing pile would read as the sweeper
    // falling behind and be waited out.
    Metrics.ReceiptsAbandoned.collectWith(async (gauge) => {
      await this.safely('abandoned receipts', async () =>
        gauge.set({}, await this.overlay.receiptsAbandoned(MAX_RECEIPT_ATTEMPTS)),
      );
    });
  }

  /**
   * Swallows a read failure, since a throwing collector fails the whole scrape.
   * The last value stands until a scrape gets an answer.
   */
  private async safely(what: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (error) {
      this.logger.debug(`${what} unavailable this scrape: ${String(error)}`);
    }
  }
}
