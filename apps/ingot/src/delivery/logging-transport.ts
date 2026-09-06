import { Injectable, Logger } from '@nestjs/common';
import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';
import type { DeliveryTransport } from './delivery-transport.port.js';

/**
 * The transport for `{"t":"none"}`: a debug line, and nothing leaves the process.
 *
 * A real transport rather than a branch in the router, so `none` is a member of
 * the same closed record as the other two and the router has one code path. It
 * is reached only by a memory that has no delivery configured — and only then
 * because something enqueued for one that did and was reconfigured to `none`
 * before the worker got to it, which is a race worth draining rather than
 * leaving in the queue for ever.
 *
 * Debug rather than log: a memory under load produces a receipt per `/add` that
 * asked for one, and an info line each would drown the log for a fact nobody is
 * waiting on.
 */
@Injectable()
export class LoggingTransport implements DeliveryTransport {
  private readonly logger = new Logger(LoggingTransport.name);

  async deliver(_target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
    this.logger.debug(
      `Receipt ready for ${payload.batch} on "${payload.sourceTable}" ` +
        `(${payload.model}), delivered nowhere: ${payload.searchTerm}`,
    );
  }
}
