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
 * `RmqTransport`'s bookkeeping around a broker: queues declared once per
 * connection, that cache dropped when the connection is, and one connection per
 * burst.
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

  // A replaced broker has none of the declared queues, and AMQP silently
  // discards a publish to an undeclared queue, so the cache must reset on reconnect.
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

  // First delivery in a burst opens the connection; the rest await it.
  it('opens one connection for a burst', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => transport.deliver(to('receipts'), receipt())),
    );

    expect(broker.connections()).toBe(1);
    expect(broker.published).toHaveLength(8);
  });

  // Queue names are unbounded caller input, so the cache is cleared at `MAX_DECLARED`.
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

  // With no broker configured, delivery is refused rather than dropped.
  it('refuses when the broker has been taken away', async () => {
    const without = new RmqTransport({ ...SETTINGS, brokerUrl: null }, broker.connect);

    expect(without.deliver(to('receipts'), receipt())).rejects.toThrow(/INGOT_RABBITMQ_URL/);
    expect(broker.connections()).toBe(0);
  });
});
