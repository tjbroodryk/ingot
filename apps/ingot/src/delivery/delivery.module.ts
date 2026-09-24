import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { AMQP_CONNECT, type AmqpConnect } from './amqp.port.js';
import { DELIVERY_SETTINGS, type DeliverySettings, deliverySettings } from './delivery-settings.js';
import { DELIVERY_TRANSPORT } from './delivery-transport.port.js';
import { LoggingTransport } from './logging-transport.js';
import { RmqTransport } from './rmq-transport.js';
import { RoutingTransport } from './routing-transport.js';
import { WebhookTransport } from './webhook-transport.js';

/**
 * How receipts are delivered, logged at boot. Global because `records/` sends
 * deliveries and `ingots/` needs the settings to refuse an unavailable strategy
 * at configure time. A missing transport is not fatal: it's refused at the call
 * that tries.
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
    // The real connect, bound once; a port rather than a module import.
    { provide: AMQP_CONNECT, useValue: amqp.connect as AmqpConnect },
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
