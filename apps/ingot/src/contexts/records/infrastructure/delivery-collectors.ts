import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import { Metrics } from '../../../observability/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';

/**
 * The numbers that say whether receipts are reaching the people told to expect
 * them.
 *
 * Read at scrape time from Postgres rather than maintained by increments, for
 * the reason gauges usually are: an incremented gauge drifts, and drifts
 * plausibly. If pending climbs steadily, a receiver is down or delivery has
 * stopped; if abandoned climbs at all, somebody has been promised something
 * they will not get.
 *
 * Two series and not one, deliberately. An abandoned delivery is not a backlog
 * that will clear — summed into the pending count, a growing pile of them would
 * read as a worker falling behind and be waited out.
 */
@Injectable()
export class DeliveryCollectors implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeliveryCollectors.name);

  constructor(
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings,
  ) {}

  onApplicationBootstrap(): void {
    Metrics.DeliveriesPending.collectWith(async (gauge) => {
      await this.safely('pending deliveries', async () =>
        gauge.set({}, await this.outbox.pending(this.settings.maxAttempts)),
      );
    });

    Metrics.DeliveriesAbandoned.collectWith(async (gauge) => {
      await this.safely('abandoned deliveries', async () =>
        gauge.set({}, await this.outbox.abandoned(this.settings.maxAttempts)),
      );
    });
  }

  /**
   * A collector that throws fails the whole scrape, not just its own series —
   * so a database blip would take every application metric with it, at exactly
   * the moment they matter. The last value stands until a scrape gets an answer.
   */
  private async safely(what: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (error) {
      this.logger.debug(`${what} unavailable this scrape: ${String(error)}`);
    }
  }
}
