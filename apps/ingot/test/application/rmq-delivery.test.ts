import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type DeliveredReceipt,
  DeliveryEvent,
  DeliveryKind,
  type DeliveryStrategy,
} from '@ingot/shared/ingot-v1';
import type { AmqpConnect } from '../../src/delivery/amqp.port.js';
import {
  DEFAULT_DELIVERY_ATTEMPTS,
  DEFAULT_USER_AGENT,
} from '../../src/delivery/delivery-settings.js';
import { DeliveryRefused } from '../../src/delivery/delivery-transport.port.js';
import { MAX_DECLARED, RmqTransport } from '../../src/delivery/rmq-transport.js';

/**
 * The bookkeeping around a broker, which is the part of `RmqTransport` worth
 * asserting.
 *
 * AMQP itself is amqplib's problem and it has its own suite. What is ours is
 * what surrounds it: that a queue is declared once per connection rather than
 * once per message, that what we believe the broker has declared is dropped the
 * moment the connection telling us so is, and that a burst of deliveries opens
 * one connection rather than one each.
 *
 * That is all observable through a stand-in that counts calls, and none of it
 * is observable at all through a real broker — which is why `AMQP_CONNECT` is a
 * port. No container and no database: this is one class and a fake.
 */

/** A confirm channel that counts what was asked of it. */
function fakeBroker() {
  const asserted: string[] = [];
  const published: { queue: string; messageId: string }[] = [];
  const listeners = new Map<string, (arg?: unknown) => void>();
  let connections = 0;
  let publishFails = false;

  const channel = {
    async assertQueue(queue: string) {
      asserted.push(queue);
      return { queue, messageCount: 0, consumerCount: 0 };
    },
    publish(_exchange: string, queue: string, _content: Buffer, options: { messageId: string }) {
      if (publishFails) throw new Error('broker said no');
      published.push({ queue, messageId: options.messageId });
      return true;
    },
    async waitForConfirms() {},
  };

  const model = {
    on(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, listener);
      return model;
    },
    async createConfirmChannel() {
      return channel;
    },
    async close() {},
  };

  return {
    asserted,
    published,
    connections: () => connections,
    failPublishes: (failing: boolean) => {
      publishFails = failing;
    },
    /** What amqplib does on its own when a broker comes back. */
    reconnect: () => listeners.get('connect')?.(),
    connect: (async () => {
      connections += 1;
      return model;
    }) as unknown as AmqpConnect,
  };
}

const SETTINGS = {
  brokerUrl: 'amqp://broker',
  exchange: '',
  timeoutMs: 10_000,
  maxAttempts: DEFAULT_DELIVERY_ATTEMPTS,
  userAgent: DEFAULT_USER_AGENT,
};

function to(queue: string): DeliveryStrategy {
  return { t: DeliveryKind.Rmq, queue };
}

let batches = 0;
function receipt(): DeliveredReceipt {
  batches += 1;
  return {
    event: DeliveryEvent.ReceiptReady,
    ingot: 'ing_1',
    batch: `batch_${batches}`,
    externalId: null,
    sourceTable: 'notes',
    summary: 'a summary',
    searchTerm: 'a search term',
    totalResults: 1,
    query: 'SELECT 1',
    model: 'test-model',
    readyAt: '2026-09-06T11:02:04Z',
    attempt: 1,
  };
}

describe('delivering to a broker', () => {
  let broker: ReturnType<typeof fakeBroker>;
  let transport: RmqTransport;

  beforeEach(() => {
    broker = fakeBroker();
    transport = new RmqTransport(SETTINGS, broker.connect);
  });

  /**
   * The reason this cache exists. Declaring is a fact about the connection, so
   * paying a round trip for it per message doubled the cost of delivering one
   * receipt — on every replica, independently.
   */
  it('declares a queue once, however many receipts go to it', async () => {
    for (let at = 0; at < 5; at++) await transport.deliver(to('receipts'), receipt());

    expect(broker.asserted).toEqual(['receipts']);
    expect(broker.published).toHaveLength(5);
    expect(broker.connections()).toBe(1);
  });

  it('declares each queue it has not seen before', async () => {
    await transport.deliver(to('one'), receipt());
    await transport.deliver(to('two'), receipt());
    await transport.deliver(to('one'), receipt());

    expect(broker.asserted).toEqual(['one', 'two']);
  });

  /**
   * The invalidation, and the failure it exists to prevent.
   *
   * A broker replaced underneath us — a fresh instance, an empty volume — has
   * none of the queues we declared. Publishing to the default exchange with a
   * routing key naming a queue that is not there is *silently discarded* by
   * AMQP, so a cache that outlived its connection would swallow every delivery
   * while reporting success. Which is the exact failure asserting was added to
   * prevent, reached by another route.
   */
  it('forgets what it declared when amqplib reconnects', async () => {
    await transport.deliver(to('receipts'), receipt());
    expect(broker.asserted).toEqual(['receipts']);

    broker.reconnect();

    await transport.deliver(to('receipts'), receipt());
    expect(broker.asserted).toEqual(['receipts', 'receipts']);
  });

  it('forgets what it declared when a publish drops the channel', async () => {
    await transport.deliver(to('receipts'), receipt());

    broker.failPublishes(true);
    expect(transport.deliver(to('receipts'), receipt())).rejects.toThrow(DeliveryRefused);

    // A new connection, and the queue declared on it before anything is sent.
    broker.failPublishes(false);
    await transport.deliver(to('receipts'), receipt());

    expect(broker.connections()).toBe(2);
    expect(broker.asserted).toEqual(['receipts', 'receipts']);
  });

  it('forgets what it declared on shutdown', async () => {
    await transport.deliver(to('receipts'), receipt());
    await transport.onModuleDestroy();
    await transport.deliver(to('receipts'), receipt());

    expect(broker.asserted).toEqual(['receipts', 'receipts']);
  });

  /**
   * A burst must not open a connection each: the first delivery to arrive owns
   * the attempt and the rest await it.
   */
  it('opens one connection for a burst', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => transport.deliver(to('receipts'), receipt())),
    );

    expect(broker.connections()).toBe(1);
    expect(broker.published).toHaveLength(8);
  });

  /**
   * Queue names come from callers — one per memory that asked for `rmq` — so
   * this is unbounded input and something has to cap it. A cold start every
   * `MAX_DECLARED` distinct queues costs one round trip per queue, which is
   * what the cache was saving; a Set that grows without limit costs a pod.
   */
  it('starts the cache again rather than growing without a bound', async () => {
    for (let at = 0; at < MAX_DECLARED; at++) {
      await transport.deliver(to(`queue-${at}`), receipt());
    }
    expect(broker.asserted).toHaveLength(MAX_DECLARED);

    // The first queue is still in the cache right up to the cap.
    await transport.deliver(to('queue-0'), receipt());
    expect(broker.asserted).toHaveLength(MAX_DECLARED);

    // One past it clears the lot, so the next repeat is declared again.
    await transport.deliver(to('one-too-many'), receipt());
    await transport.deliver(to('queue-0'), receipt());

    expect(broker.asserted.slice(-2)).toEqual(['one-too-many', 'queue-0']);
  });

  it('puts the batch on the envelope, so a consumer can deduplicate', async () => {
    const body = receipt();
    await transport.deliver(to('receipts'), body);

    expect(broker.published[0]).toEqual({ queue: 'receipts', messageId: body.batch });
  });

  it('refuses a target that is not a queue', async () => {
    expect(
      transport.deliver({ t: DeliveryKind.Webhook, endpoint: 'https://e.dev/h' }, receipt()),
    ).rejects.toThrow(DeliveryRefused);
  });

  /**
   * Reachable only for a memory configured while a broker was set and delivered
   * after it was unset. Refused rather than dropped: the row stays in the
   * outbox, and the gauge says somebody took the broker away from memories
   * still pointed at it.
   */
  it('refuses when the broker has been taken away', async () => {
    const without = new RmqTransport({ ...SETTINGS, brokerUrl: null }, broker.connect);

    expect(without.deliver(to('receipts'), receipt())).rejects.toThrow(/INGOT_RABBITMQ_URL/);
    expect(broker.connections()).toBe(0);
  });
});
