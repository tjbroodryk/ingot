import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DELIVERY_SETTINGS, type DeliverySettings, deliverySettings } from './delivery-settings.js';
import { DELIVERY_TRANSPORT } from './delivery-transport.port.js';
import { LoggingTransport } from './logging-transport.js';
import { RmqTransport } from './rmq-transport.js';
import { RoutingTransport } from './routing-transport.js';
import { WebhookTransport } from './webhook-transport.js';

/**
 * How this deployment delivers a receipt, and a line at boot saying so.
 *
 * Global for the reason `AiModule` is: two contexts need it and they are not
 * the same one. `records/` sends the deliveries, and `ingots/` needs the
 * settings to refuse a strategy this deployment cannot honour at the moment
 * somebody configures it — rather than accepting it and failing every delivery
 * afterwards, in a worker, to nobody who can see the answer.
 *
 * Unlike `AiModule`, a missing transport is not a refusal to boot. There is no
 * silent-wrong-answer here to protect against: a deployment with no broker
 * simply cannot be configured for one, and it is told at the call that tries.
 */
@Global()
@Module({
  providers: [
    {
      provide: DELIVERY_SETTINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DeliverySettings => {
        const settings = deliverySettings((key) => config.get<string>(key));
        announce(settings);
        return settings;
      },
    },
    WebhookTransport,
    RmqTransport,
    LoggingTransport,
    RoutingTransport,
    { provide: DELIVERY_TRANSPORT, useExisting: RoutingTransport },
  ],
  exports: [DELIVERY_SETTINGS, DELIVERY_TRANSPORT],
})
export class DeliveryModule {}

function announce(settings: DeliverySettings): void {
  const transports = ['webhook', ...(settings.brokerUrl === null ? [] : ['rmq'])];
  Logger.log(
    `Receipts deliver by ${transports.join(' and ')}, ` +
      `${settings.maxAttempts} attempts at ${settings.timeoutMs}ms`,
    'Delivery',
  );
}
