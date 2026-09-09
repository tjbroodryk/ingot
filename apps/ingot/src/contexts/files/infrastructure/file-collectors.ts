import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Metrics } from '../../../observability/index.js';
import { MAX_FILE_ATTEMPTS } from '../application/commands/claim-file.command.js';
import { FILE_QUEUE, type FileQueue } from '../application/ports/file-queue.port.js';

/**
 * The numbers that say whether documents are being read.
 *
 * Registered here rather than with the pool collector because they count rows
 * in a table this context owns — `observability/` should not have to know what
 * a parse queue is to report on one.
 *
 * Read at scrape time rather than maintained by increments, for the reason
 * every gauge in this service is: an incremented gauge drifts, and it drifts
 * plausibly. A climbing pending count means parsing has stopped keeping up; a
 * non-zero abandoned count means something is wrong with a specific document
 * and nothing further will happen to it.
 */
@Injectable()
export class FileCollectors implements OnApplicationBootstrap {
  private readonly logger = new Logger(FileCollectors.name);

  constructor(@Inject(FILE_QUEUE) private readonly queue: FileQueue) {}

  onApplicationBootstrap(): void {
    Metrics.FilesPending.collectWith(async (gauge) => {
      await this.safely('pending documents', async () =>
        gauge.set({}, await this.queue.pending(MAX_FILE_ATTEMPTS)),
      );
    });

    // Kept apart from the pending count for the reason the receipt gauges are
    // kept apart: an abandoned document is not a backlog that will clear. It is
    // a caller holding two queries, one of which now answers "failed" — which
    // is better than a receipt manages, and still not something to wait out.
    Metrics.FilesAbandoned.collectWith(async (gauge) => {
      await this.safely('abandoned documents', async () =>
        gauge.set({}, await this.queue.abandoned(MAX_FILE_ATTEMPTS)),
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
