import { Injectable } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import type { DeliveryTransport } from './delivery-transport.port.js';
import { LoggingTransport } from './logging-transport.js';
import { RmqTransport } from './rmq-transport.js';
import { WebhookTransport } from './webhook-transport.js';

/**
 * The one transport the worker sees, dispatching on what the row asked for.
 *
 * A record keyed on `DeliveryKind` rather than a switch, so a transport added
 * to the enum without an implementation fails to compile instead of falling
 * through to a default at runtime — the same construction `AiModule` uses for
 * providers, and for the same reason: the failure it prevents is a strategy
 * that a caller can configure and that silently delivers nowhere.
 *
 * It dispatches on the **row's** target, never on what the memory says now.
 * Those differ exactly when somebody reconfigures delivery while a receipt is
 * in flight, and the row is the one that was true when the promise was made.
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
