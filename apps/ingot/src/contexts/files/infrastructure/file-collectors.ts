import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Metrics } from '../../../observability/index.js';
import { MAX_FILE_ATTEMPTS } from '../application/commands/claim-file.command.js';
import { FILE_QUEUE, type FileQueue } from '../application/ports/file-queue.port.js';

/**
 * The gauges that say whether documents are being read.
 *
 * Read at scrape time rather than incremented, since an incremented gauge
 * drifts. Pending climbing means parsing is behind; abandoned non-zero means a
 * specific document is stuck.
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

    // Apart from pending: an abandoned document is not a backlog that will clear.
    Metrics.FilesAbandoned.collectWith(async (gauge) => {
      await this.safely('abandoned documents', async () =>
        gauge.set({}, await this.queue.abandoned(MAX_FILE_ATTEMPTS)),
      );
    });
  }

  /**
   * A throwing collector fails the whole scrape, not just its series, so failures
   * are swallowed and the last value stands.
   */
  private async safely(what: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (error) {
      this.logger.debug(`${what} unavailable this scrape: ${String(error)}`);
    }
  }
}
