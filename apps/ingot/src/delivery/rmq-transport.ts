import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import type * as amqp from 'amqplib';
import { upstream } from '../observability/index.js';
import { AMQP_CONNECT, type AmqpConnect } from './amqp.port.js';
import { DELIVERY_SETTINGS, type DeliverySettings } from './delivery-settings.js';
import { DeliveryRefused, type DeliveryTransport } from './delivery-transport.port.js';

/**
 * One message per receipt onto a queue on the configured broker. A confirm
 * channel, so the broker acknowledges before the outbox row is marked done. The
 * connection is lazy (first publish) and shared; `recovery: true` is amqplib's
 * reconnect, and what it can't recover from throws for the queue to retry. The
 * queue is asserted durable on every publish, since the default exchange silently
 * discards a message to a missing queue.
 */
@Injectable()
export class RmqTransport implements DeliveryTransport, OnModuleDestroy {
  private readonly logger = new Logger(RmqTransport.name);

  /** Opened on the first publish, kept afterwards, dropped on any failure. */
  private model: amqp.RecoveringChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  /** In-flight connect, so a burst of deliveries opens one connection. */
  private connecting: Promise<amqp.ConfirmChannel> | null = null;

  /**
   * Queues already declared on the current connection; `assertQueue` is a round
   * trip, so it's remembered per connection. Cleared whenever the connection is:
   * a broker replaced underneath us would otherwise swallow deliveries to queues
   * it no longer has.
   */
  private readonly declared = new Set<string>();

  constructor(
    @Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings,
    @Inject(AMQP_CONNECT) private readonly connector: AmqpConnect,
  ) {}

  async deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
    if (target.t !== DeliveryKind.Rmq) {
      throw new DeliveryRefused('rmq', `cannot deliver a "${target.t}" target`);
    }
    if (this.settings.brokerUrl === null) {
      // Reachable only if a broker was configured, then unset. Refused, not dropped, so the row stays queued.
      throw new DeliveryRefused('rmq', 'no broker is configured (INGOT_RABBITMQ_URL is unset)');
    }

    // `host` is a code constant, never the broker URL: that would be an unbounded
    // label and leak credentials into metrics.
    await upstream('rabbitmq', 'publish', async (span) => {
      span.set({
        'delivery.batch': payload.batch,
        'delivery.attempt': payload.attempt,
        'delivery.queue': target.queue,
      });

      const channel = await this.open();
      try {
        if (!this.declared.has(target.queue)) {
          await channel.assertQueue(target.queue, { durable: true });
          // Remember only after the broker agrees; recording early would never retry a failed declaration.
          this.remember(target.queue);
        }
        channel.publish(
          this.settings.exchange,
          target.queue,
          Buffer.from(JSON.stringify(payload)),
          {
            contentType: 'application/json',
            // Written to disk by the broker, so a restart before the consumer doesn't lose it.
            persistent: true,
            type: payload.event,
            // What a consumer deduplicates on; at-least-once means the batch is on the envelope too.
            messageId: payload.batch,
            appId: this.settings.userAgent,
          },
        );
        await channel.waitForConfirms();
      } catch (error) {
        // The channel is unusable after most AMQP errors; drop it so the next attempt builds a fresh one.
        this.discard();
        throw new DeliveryRefused('rmq', message(error));
      }
    });
  }

  /** The confirm channel, opening one if this is the first delivery. */
  private async open(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return this.channel;
    // First arrival owns the connect; the rest await it.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<amqp.ConfirmChannel> {
    const url = this.settings.brokerUrl as string;
    try {
      const model = await this.connector(url, { recovery: true });
      model.on('error', (error) => this.logger.warn(`Broker connection: ${message(error)}`));
      // amqplib reconnects silently; a returned broker may be empty, so drop what we think it declared.
      model.on('connect', () => {
        this.declared.clear();
        this.logger.log('Reconnected to the broker');
      });
      // Not a reason to drop anything: amqplib is reconnecting, and an in-flight delivery fails and is retried.
      model.on('disconnect', (error) => this.logger.warn(`Broker away: ${message(error)}`));

      const channel = await model.createConfirmChannel();
      this.model = model;
      this.channel = channel;
      this.logger.log('Connected to the broker');
      return channel;
    } catch (error) {
      this.discard();
      throw new DeliveryRefused('rmq', `could not reach the broker: ${message(error)}`);
    }
  }

  private discard(): void {
    const model = this.model;
    this.channel = null;
    this.model = null;
    this.declared.clear();
    // Detached, failures swallowed: the connection is already broken, and awaiting close would only slow a failed delivery.
    void model?.close().catch(() => undefined);
  }

  /** Records a declared queue, starting the cache again if it is full. */
  private remember(queue: string): void {
    if (this.declared.size >= MAX_DECLARED) this.declared.clear();
    this.declared.add(queue);
  }

  /**
   * `onModuleDestroy`, so the broker is let go before the pool: an in-flight
   * delivery fails on its own connection, not a closed database.
   */
  async onModuleDestroy(): Promise<void> {
    const model = this.model;
    this.channel = null;
    this.model = null;
    this.declared.clear();
    await model?.close().catch(() => undefined);
  }
}

/**
 * How many declared queues are remembered before the cache resets. A crude bound,
 * not an LRU: queue names are unbounded caller input, and a reset costs one extra
 * round trip per queue.
 */
export const MAX_DECLARED = 1024;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
