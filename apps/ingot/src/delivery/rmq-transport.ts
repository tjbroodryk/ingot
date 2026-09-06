import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import type * as amqp from 'amqplib';
import { upstream } from '../observability/index.js';
import { AMQP_CONNECT, type AmqpConnect } from './amqp.port.js';
import { DELIVERY_SETTINGS, type DeliverySettings } from './delivery-settings.js';
import { DeliveryRefused, type DeliveryTransport } from './delivery-transport.port.js';

/**
 * One message per receipt, onto a queue on the deployment's broker.
 *
 * ## Why a confirm channel
 *
 * An ordinary AMQP publish is fire-and-forget: `publish` returns true when the
 * message was written to a socket, which says nothing about whether the broker
 * took it. Marking the outbox row done on that basis would be the same silent
 * loss the outbox exists to prevent, moved one hop along. A confirm channel
 * makes the broker acknowledge, and `waitForConfirms` is what turns that back
 * into something a caller can await.
 *
 * ## Why the connection is lazy and shared
 *
 * A connection per delivery would be a TCP handshake and an AMQP handshake per
 * receipt, which is most of the cost of sending one. So the model is opened on
 * the first publish and kept — and it is opened on the *first publish* rather
 * than at boot, so a deployment that has configured a broker but is not yet
 * delivering anything does not hold a connection open, and a broker that is
 * down does not stop the service starting.
 *
 * `recovery: true` is amqplib's own reconnect, which handles the ordinary case
 * of a broker restarting underneath us. It is not the whole answer: anything it
 * cannot recover from throws out of `deliver`, the worker counts the attempt,
 * and the row waits in the queue for the next sweep. The channel is dropped on
 * any failure so the next attempt builds a fresh one rather than reusing a
 * channel the broker may already have closed.
 *
 * ## Why the queue is asserted
 *
 * Durable, and asserted on every publish — cheap when it already exists, and
 * the difference between "the queue was not declared yet" and a message routed
 * into nothing. Publishing to the default exchange with a routing key naming a
 * queue that does not exist is silently discarded by AMQP, which is exactly the
 * failure this whole design refuses to have.
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
   * Queues already declared on the connection currently open.
   *
   * `assertQueue` is idempotent and cheap, but it is still a round trip to the
   * broker — and it was one *per message*, so a memory under load paid two
   * round trips to deliver one receipt and every replica paid them separately.
   * Declaring is a fact about the connection, not about the message, so it is
   * remembered for as long as that connection is.
   *
   * **Cleared whenever the connection is, and that is the whole of the
   * invalidation.** A cache that outlived a connection would be the one failure
   * this assert exists to prevent, arrived at by a different route: publishing
   * to the default exchange with a routing key naming a queue that is not there
   * is silently discarded by AMQP, so a broker replaced underneath us — a fresh
   * instance, an empty volume — would swallow every delivery while reporting
   * success. So it is dropped on `discard`, on shutdown, and on amqplib's own
   * `connect` event, which is the reconnection we are not otherwise told about.
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
      // Reachable only for a memory configured while a broker was set and
      // delivered after it was unset. Refused rather than dropped: the row
      // stays in the queue, and the gauge says somebody has taken the broker
      // away from memories that are still pointed at it.
      throw new DeliveryRefused('rmq', 'no broker is configured (INGOT_RABBITMQ_URL is unset)');
    }

    // `host` is a code constant, never the broker URL — that would be an
    // unbounded label and, with credentials in it, a secret in the metrics.
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
          // Remembered only once the broker has agreed. Recording it before
          // would mean a failed declaration is never retried on this
          // connection, and every later publish routes into nothing.
          this.remember(target.queue);
        }
        channel.publish(
          this.settings.exchange,
          target.queue,
          Buffer.from(JSON.stringify(payload)),
          {
            contentType: 'application/json',
            // Written to disk by the broker, so a restart between the confirm
            // and the consumer does not lose what we were just told landed.
            persistent: true,
            type: payload.event,
            // What a consumer deduplicates on. At-least-once is the contract, so
            // the receipt's batch has to be on the envelope as well as in it.
            messageId: payload.batch,
            appId: this.settings.userAgent,
          },
        );
        await channel.waitForConfirms();
      } catch (error) {
        // The channel is unusable after most AMQP errors, and a closed one
        // fails every later publish with the same message. Drop it and let the
        // next attempt build a fresh one.
        this.discard();
        throw new DeliveryRefused('rmq', message(error));
      }
    });
  }

  /** The confirm channel, opening one if this is the first delivery. */
  private async open(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return this.channel;
    // A burst of deliveries must not each start a connection: the first one to
    // arrive owns the attempt and the rest await it.
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
      // amqplib reconnects on its own, and does not tell the channel. A broker
      // that came back is one that may have come back empty, so what we
      // believe it has declared goes with the connection that told us.
      model.on('connect', () => {
        this.declared.clear();
        this.logger.log('Reconnected to the broker');
      });
      // Not an error and not a reason to drop anything: amqplib is already
      // reconnecting, and a delivery in flight will fail on its own and be
      // retried from the queue.
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
    // Detached, and failures swallowed: this is a connection already known to
    // be broken, and awaiting its close would make a failed delivery slower
    // for no gain.
    void model?.close().catch(() => undefined);
  }

  /** Records a declared queue, starting the cache again if it is full. */
  private remember(queue: string): void {
    if (this.declared.size >= MAX_DECLARED) this.declared.clear();
    this.declared.add(queue);
  }

  /**
   * `onModuleDestroy`, so the broker is let go before the pool is — the same
   * ordering `Scheduler` relies on, and for the same reason: a delivery still
   * in flight during a shutdown should fail on its own connection rather than
   * on a database that has already gone.
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
 * How many declared queues are remembered before the cache starts again.
 *
 * A bound rather than an LRU, and the crudeness is deliberate. Queue names come
 * from callers — one per memory that asked for `rmq` — so this is unbounded
 * input, and something has to cap it. What an LRU would buy is avoiding a cold
 * start every `MAX_DECLARED` distinct queues; what a cold start costs is one
 * extra round trip per queue, which is what this whole cache was saving in the
 * first place. A deployment with more than a thousand distinct delivery queues
 * pays that occasionally, and gets a Set that cannot grow instead.
 */
export const MAX_DECLARED = 1024;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
