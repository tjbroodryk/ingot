import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import { Metrics } from '../../../observability/index.js';
import { MAX_FILE_ATTEMPTS } from '../../files/application/commands/claim-file.command.js';
import { FILE_QUEUE, type FileQueue } from '../../files/application/ports/file-queue.port.js';
import { BackgroundKind, BackgroundWork } from '../application/background.js';
import { MAX_RECEIPT_ATTEMPTS } from '../application/commands/claim-receipt.command.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';
import { OVERLAY_STORE, type OverlayStore } from '../application/ports/overlay-store.port.js';

/**
 * How busy this pod's background drains are, and how far behind each queue is.
 * Together they are what a pod count can be scaled on.
 */
@Injectable()
export class BackgroundCollectors implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackgroundCollectors.name);

  constructor(
    private readonly background: BackgroundWork,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(DELIVERY_SETTINGS) private readonly delivery: DeliverySettings,
    @Inject(FILE_QUEUE) private readonly files: FileQueue,
  ) {}

  onApplicationBootstrap(): void {
    Metrics.BackgroundDrainsInFlight.collectWith((gauge) => {
      for (const queue of Object.values(BackgroundKind)) {
        gauge.set({ queue }, this.background.inFlight(queue));
      }
    });

    Metrics.BackgroundDrainLimit.collectWith((gauge) => {
      for (const queue of Object.values(BackgroundKind)) {
        gauge.set({ queue }, this.background.limit(queue));
      }
    });

    const oldest: Record<BackgroundKind, () => Promise<number>> = {
      [BackgroundKind.Embeddings]: () => this.overlay.oldestPendingSeconds(),
      [BackgroundKind.Receipts]: () => this.overlay.oldestReceiptSeconds(MAX_RECEIPT_ATTEMPTS),
      [BackgroundKind.Deliveries]: () =>
        this.outbox.oldestPendingSeconds(this.delivery.maxAttempts),
      [BackgroundKind.Files]: () => this.files.oldestPendingSeconds(MAX_FILE_ATTEMPTS),
    };

    Metrics.BackgroundOldestPending.collectWith(async (gauge) => {
      await Promise.all(
        Object.values(BackgroundKind).map(async (queue) => {
          try {
            gauge.set({ queue }, await oldest[queue]());
          } catch (error) {
            // A collector that throws fails the whole scrape; the last value stands.
            this.logger.debug(`oldest pending ${queue} unavailable this scrape: ${String(error)}`);
          }
        }),
      );
    });
  }
}
