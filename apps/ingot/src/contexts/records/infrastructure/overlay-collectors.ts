import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Metrics } from '../../../observability/index.js';
import { MAX_RECEIPT_ATTEMPTS } from '../application/commands/claim-receipt.command.js';
import { OVERLAY_STORE, type OverlayStore } from '../application/ports/overlay-store.port.js';

/**
 * The numbers that say whether the background is keeping up.
 *
 * Registered here rather than with the pool collector because they count rows
 * in tables this context owns — `observability/` should not have to know what
 * an overlay is to report on one.
 *
 * Read at scrape time from Postgres rather than maintained by increments, for
 * the reason gauges usually are: an incremented gauge drifts, and drifts
 * plausibly. If the depth climbs steadily, roll-up has stopped; if pending
 * embeddings climb, the embedder has.
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

    // Kept apart from the pending count on purpose: an abandoned receipt is not
    // a backlog that will clear, it is a caller holding a query that will stay
    // empty for good. Summed into one gauge, a growing pile of those would
    // read as a sweeper falling behind and be waited out.
    Metrics.ReceiptsAbandoned.collectWith(async (gauge) => {
      await this.safely('abandoned receipts', async () =>
        gauge.set({}, await this.overlay.receiptsAbandoned(MAX_RECEIPT_ATTEMPTS)),
      );
    });
  }

  /**
   * A collector that throws fails the whole scrape, not just its own series —
   * so a database blip would take the pool gauge and every application metric
   * with it, at exactly the moment they matter. The last value stands until a
   * scrape gets an answer.
   */
  private async safely(what: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (error) {
      this.logger.debug(`${what} unavailable this scrape: ${String(error)}`);
    }
  }
}
