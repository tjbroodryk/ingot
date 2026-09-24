import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import { Metrics } from '../../../observability/index.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';

/**
 * Gauges for whether receipts are reaching their targets. Read at scrape time
 * from Postgres rather than incremented, since an incremented gauge drifts. Two
 * series: an abandoned delivery is not a backlog that will clear.
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
