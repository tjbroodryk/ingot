import { Injectable, Logger } from '@nestjs/common';
import type { DeliveredReceipt, DeliveryStrategy } from '@ingot/shared/ingot-v1';
import type { DeliveryTransport } from './delivery-transport.port.js';

/**
 * The transport for `{"t":"none"}`: a debug line, nothing leaves the process. A
 * real transport so `none` shares the router's one code path; reached when a
 * queued delivery was retargeted to `none`. Debug, not info, to avoid a line per receipt.
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
