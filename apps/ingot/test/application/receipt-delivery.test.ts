import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ColumnType,
  type DeliveredReceipt,
  DeliveryEvent,
  DeliveryKind,
  type DeliveryStrategy,
  ReceiptKind,
} from '@ingot/shared/ingot-v1';
import { DeliveryRefused } from '../../src/delivery/delivery-transport.port.js';
import { BackgroundKind } from '../../src/contexts/records/application/background.js';
import { DeleteIngot } from '../../src/contexts/ingots/application/commands/delete-ingot.command.js';
import { openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

const ENDPOINT = 'https://example.com/hooks/ingot';

/** A receipt reaches its memory's nominated target via the outbox, exactly once. */
describe('delivering a receipt', () => {
  let world: World;

  /** Everything the transport was handed, in order. */
  const sent: { target: DeliveryStrategy; payload: DeliveredReceipt }[] = [];

  /** How many more deliveries to refuse before accepting again. */
  let refusals = 0;

  /** What a second connection could see while the transport was being called. */
  const observed: { claimed: boolean; attempts: number }[] = [];

  const recorder = {
    async deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
      const { pool } = await openDatabase();
      const seen = await pool.query<{ claimed_at: Date | null; attempts: number }>(
        'SELECT claimed_at, attempts FROM receipt_delivery_queue WHERE batch = $1',
        [payload.batch],
      );
      observed.push({
        claimed: seen.rows[0]?.claimed_at != null,
        attempts: seen.rows[0]?.attempts ?? 0,
      });

      if (refusals > 0) {
        refusals -= 1;
        throw new DeliveryRefused('webhook', 'service unavailable', 503);
      }
      sent.push({ target, payload });
    },
  };

  /** Stores one row asking for a receipt, and returns the batch it was given. */
  async function store(ingot: string, slug: string): Promise<string> {
    const added = await world.add(ingot, {
      table: 'notes',
      key: ['slug'],
      columns: {
        slug: { from: '$.slug', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar },
      },
      receipt: ReceiptKind.Full,
      result: { slug, body: 'something worth describing' },
    });
    return added.receipt?.batch as string;
  }

  async function queued(batch: string): Promise<{ target: unknown; attempts: number } | null> {
    const { pool } = await openDatabase();
    const rows = await pool.query<{ target: unknown; attempts: number }>(
      'SELECT target, attempts FROM receipt_delivery_queue WHERE batch = $1',
      [batch],
    );
    return rows.rows[0] ?? null;
  }

  beforeAll(async () => {
    world = await makeWorld({ transport: recorder });
  });

  beforeEach(() => {
    sent.length = 0;
    observed.length = 0;
    refusals = 0;
  });

  afterAll(async () => {
    await world.close();
  });

  // A memory with no target writes no outbox row at all.
  it('queues nothing for a memory with no target', async () => {
    const ingot = await world.ingot('an unconfigured memory');
    const batch = await store(ingot, 'quiet');

    expect(await world.summariseAll()).toBe(1);

    expect(await queued(batch)).toBeNull();
    expect(await world.deliverAll()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('reports where a memory delivers, defaults included', async () => {
    const ingot = await world.ingot('a configured memory');

    expect((await world.info(ingot)).config).toEqual({ delivery: { t: DeliveryKind.None } });

    const config = await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });

    expect(config).toEqual({ delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT } });
    expect((await world.info(ingot)).config).toEqual(config);
  });

  // After the receipt is written the row is in the outbox and nothing has gone out.
  it('announces into the outbox when the receipt is written, and sends afterwards', async () => {
    const ingot = await world.ingot('a delivering memory');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    const batch = await store(ingot, 'told');

    expect(await world.summariseAll()).toBe(1);
    expect(sent).toEqual([]);
    expect(await queued(batch)).toMatchObject({
      target: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
      attempts: 0,
    });

    expect(await world.deliverAll()).toBe(1);
    expect(await queued(batch)).toBeNull();
  });

  // The delivered `query` is the same SELECT `/add` handed back.
  it('sends the receipt, and the query the caller was already given', async () => {
    const ingot = await world.ingot('a memory that describes itself');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });

    const added = await world.add(ingot, {
      table: 'notes',
      key: ['slug'],
      columns: {
        slug: { from: '$.slug', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar },
      },
      receipt: ReceiptKind.Full,
      externalId: 'call_42',
      result: { slug: 'described', body: 'something worth describing' },
    });

    await world.summariseAll();
    await world.deliverAll();

    expect(sent).toHaveLength(1);
    const [delivery] = sent;
    expect(delivery?.payload).toMatchObject({
      event: DeliveryEvent.ReceiptReady,
      ingot,
      batch: added.receipt?.batch,
      externalId: 'call_42',
      sourceTable: 'notes',
      totalResults: 1,
      query: added.receipt?.receiptQuery,
      attempt: 1,
    });
    expect(delivery?.payload.summary).toBeTruthy();
    expect(delivery?.payload.searchTerm).toBeTruthy();

    // The query it carries reads the rows the delivery describes.
    const rows = await world.sql(ingot, added.receipt?.receiptQuery as string);
    expect(rows).toHaveLength(1);
  });

  // `claimed_at` visible from a second connection means the claim committed
  // before the transport was called.
  it('has committed the claim, and let go of the connection, before calling out', async () => {
    const ingot = await world.ingot('a watched delivery');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    await store(ingot, 'watched');

    await world.summariseAll();
    await world.deliverAll();

    // Counted at claim, not in the failure handler.
    expect(observed).toEqual([{ claimed: true, attempts: 1 }]);
  });

  // A refusal costs the attempt, keeps the reason, and leaves the row in place.
  it('keeps a refused delivery, counts the attempt, and marks the retry', async () => {
    const ingot = await world.ingot('a memory with a flaky receiver');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    const batch = await store(ingot, 'refused');
    await world.summariseAll();

    refusals = 1;
    // Two passes: the first is refused and releases the lease, the second retries.
    expect(await world.deliverAll()).toBe(2);

    expect(sent).toHaveLength(1);
    // The envelope reports attempt 2, since the receiver has seen this batch before.
    expect(sent[0]?.payload.attempt).toBe(2);
    expect(await queued(batch)).toBeNull();
  });

  it('leaves the receipt written and queryable when delivery never succeeds', async () => {
    const ingot = await world.ingot('a memory nobody is listening to');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    const batch = await store(ingot, 'unheard');
    await world.summariseAll();

    refusals = Number.POSITIVE_INFINITY;
    await world.deliverAll();

    // Out of attempts and still on the row.
    const abandoned = await queued(batch);
    expect(abandoned?.attempts).toBeGreaterThan(1);

    // The receipt itself is untouched; only the delivery was lost.
    const rows = await world.sql(
      ingot,
      `SELECT summary FROM ingot_receipts WHERE source_batch = '${batch}'`,
    );
    expect(rows).toHaveLength(1);
  });

  // The target is copied onto the row at announce time, not read at send time,
  // so moving the endpoint does not redirect already-announced receipts.
  it('does not retarget a delivery that was already announced', async () => {
    const ingot = await world.ingot('a memory that moved');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    await store(ingot, 'promised');
    await world.summariseAll();

    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: 'https://elsewhere.example/hooks' },
    });
    await world.deliverAll();

    expect(sent[0]?.target).toEqual({ t: DeliveryKind.Webhook, endpoint: ENDPOINT });
  });

  it('drops undelivered announcements when the memory is destroyed', async () => {
    const ingot = await world.ingot('a memory about to go');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    const batch = await store(ingot, 'doomed');
    await world.summariseAll();
    expect(await queued(batch)).not.toBeNull();

    await world.dispatcher.send(new DeleteIngot(ingot, world.accountId));

    // Delivering this would hand a receiver a query that can only come back empty.
    expect(await queued(batch)).toBeNull();
    expect(await world.deliverAll()).toBe(0);
  });

  /** The fast path: a written receipt wakes delivery rather than waiting a tick. */
  it('wakes the delivery worker when a receipt commits', async () => {
    const ingot = await world.ingot('a memory in a hurry');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    await store(ingot, 'hurried');

    const before = world.wakes.length;
    await world.summariseAll();

    expect(world.wakes.slice(before)).toContain(BackgroundKind.Deliveries);
  });

  // An unconfigured transport is refused at the configure call, naming the var
  // that would enable it.
  it('refuses a transport this deployment cannot honour', async () => {
    const ingot = await world.ingot('a memory wanting a queue');

    expect(
      world.configureIngot(ingot, { delivery: { t: DeliveryKind.Rmq, queue: 'receipts' } }),
    ).rejects.toThrow(/INGOT_RABBITMQ_URL/);

    // And nothing moved: a refusal must not half-apply.
    expect((await world.info(ingot)).config).toEqual({ delivery: { t: DeliveryKind.None } });
  });

  it('refuses an endpoint inside its own network', async () => {
    const ingot = await world.ingot('a memory pointed inwards');

    expect(
      world.configureIngot(ingot, {
        delivery: { t: DeliveryKind.Webhook, endpoint: 'http://169.254.169.254/latest/meta-data/' },
      }),
    ).rejects.toThrow();
  });

  it('turns delivery off without disturbing anything else', async () => {
    const ingot = await world.ingot('a memory that changed its mind');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });

    const off = await world.configureIngot(ingot, { delivery: { t: DeliveryKind.None } });
    expect(off).toEqual({ delivery: { t: DeliveryKind.None } });

    const batch = await store(ingot, 'silent');
    await world.summariseAll();
    expect(await queued(batch)).toBeNull();
  });

  /** An empty patch is not an instruction to reset anything. */
  it('leaves the target alone when the patch does not mention it', async () => {
    const ingot = await world.ingot('a memory sent an empty patch');
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });

    expect(await world.configureIngot(ingot, {})).toEqual({
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
  });
});
