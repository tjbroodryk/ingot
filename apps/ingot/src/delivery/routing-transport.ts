import { Injectable } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import type { DeliveryTransport } from './delivery-transport.port.js';
import { LoggingTransport } from './logging-transport.js';
import { RmqTransport } from './rmq-transport.js';
import { WebhookTransport } from './webhook-transport.js';

/**
 * The one transport the worker sees, dispatching on what the row asked for. A
 * record keyed on `DeliveryKind`, so a kind without an implementation fails to
 * compile. Dispatches on the row's target, not the memory's current one, which
 * differ when delivery is reconfigured mid-flight.
 */
@Injectable()
export class RoutingTransport implements DeliveryTransport {
  private readonly transports: Record<DeliveryKind, DeliveryTransport>;

  constructor(webhook: WebhookTransport, rmq: RmqTransport, logging: LoggingTransport) {
    this.transports = {
      [DeliveryKind.None]: logging,
      [DeliveryKind.Webhook]: webhook,
      [DeliveryKind.Rmq]: rmq,
    };
  }

  deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
    return this.transports[target.t].deliver(target, payload);
  }
}
