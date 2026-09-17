import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ColumnType,
  type Delivered,
  DeliveryEvent,
  DeliveryKind,
  type DeliveryStrategy,
} from '@ingot/shared/ingot-v1';
import { GetPendingOperations } from '../../src/contexts/records/application/queries/get-pending-operations.query.js';
import { DropTable } from '../../src/contexts/ingots/application/commands/drop-table.command.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

const ENDPOINT = 'https://example.com/hooks/tables';
const EVERY_TABLE_EVENT = [
  DeliveryEvent.OperationsAppended,
  DeliveryEvent.TableRolledUp,
  DeliveryEvent.TableDropped,
];

/**
 * Table changes reach an ingot's delivery target, as signals to go and read.
 *
 * What is asserted is the contract a mirror depends on: an announcement exists
 * once a write commits, writes waiting on one delivery fold into it rather than
 * each queuing their own, and nothing is sent to a strategy that did not ask.
 */
describe('announcing table changes', () => {
  let world: World;
  const sent: { target: DeliveryStrategy; payload: Delivered; id: string }[] = [];

  const events = (from: number, count: number) => ({
    table: 'events',
    rows: '$.items[*]',
    columns: { n: { from: '$.n', type: ColumnType.Integer } },
    result: { items: Array.from({ length: count }, (_, at) => ({ n: from + at })) },
  });

  const waiting = async (ingot: string) => {
    const { pool } = await openDatabase();
    const found = await pool.query<{ payload: Delivered }>(
      'SELECT payload FROM receipt_delivery_queue WHERE ingot_id = $1 ORDER BY queued_at',
      [ingot],
    );
    return found.rows.map((row) => row.payload);
  };

  const listening = async (name: string, wanted = EVERY_TABLE_EVENT) => {
    const ingot = await world.ingot(name);
    await world.configureIngot(ingot, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT, events: wanted },
    });
    return ingot;
  };

  beforeAll(async () => {
    world = await makeWorld({
      transport: {
        async deliver(target, payload, id) {
          sent.push({ target, payload, id });
        },
      },
    });
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('folds writes that land before a delivery into one', async () => {
    const ingot = await listening('an ingot being mirrored');

    await world.add(ingot, events(0, 2));
    await world.add(ingot, events(2, 3));

    const queued = await waiting(ingot);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      event: DeliveryEvent.OperationsAppended,
      table: 'events',
      generation: 0,
      rows: 5,
      tombstones: 0,
    });

    // `throughSeq` is where `/pending` ends, so a receiver reading up to it has
    // everything the announcement covers.
    const pending = await world.dispatcher.ask(
      new GetPendingOperations(ingot, world.accountId, 'events'),
    );
    const through = (queued[0] as { throughSeq: string }).throughSeq;
    expect(pending.rows.at(-1)?.seq).toBe(through);

    expect(await world.deliverAll()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toMatch(/^dlv_/);
    expect(await waiting(ingot)).toEqual([]);
  });

  it('starts a new announcement once the last one has gone', async () => {
    const ingot = await listening('an ingot written after a delivery');

    await world.add(ingot, events(0, 1));
    await world.deliverAll();
    await world.add(ingot, events(1, 1));

    const queued = await waiting(ingot);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ rows: 1 });
  });

  it('announces forgotten rows, with no sequence to read to', async () => {
    const ingot = await listening('an ingot that forgets');
    await world.add(ingot, events(0, 3));
    await world.deliverAll();

    await world.forget(ingot, 'events', 'n < 2');

    expect(await waiting(ingot)).toEqual([
      expect.objectContaining({
        event: DeliveryEvent.OperationsAppended,
        rows: 0,
        tombstones: 2,
        throughSeq: null,
      }),
    ]);
  });

  it('announces a roll-up with the generation to re-read from', async () => {
    const ingot = await listening('an ingot rolled up');
    await world.add(ingot, events(0, 2));
    await world.deliverAll();

    await world.compact(ingot, 'events');

    expect(await waiting(ingot)).toEqual([
      expect.objectContaining({
        event: DeliveryEvent.TableRolledUp,
        generation: 1,
        previousGeneration: 0,
        rows: 2,
      }),
    ]);
  });

  it('announces a dropped table', async () => {
    const ingot = await listening('an ingot losing a table');
    await world.add(ingot, events(0, 1));
    await world.deliverAll();

    await world.dispatcher.send(new DropTable(ingot, world.accountId, 'events'));

    expect(await waiting(ingot)).toEqual([
      expect.objectContaining({ event: DeliveryEvent.TableDropped, table: 'events' }),
    ]);
  });

  it('sends nothing a strategy did not ask for', async () => {
    const receiptsOnly = await world.ingot('an ingot configured before table events');
    await world.configureIngot(receiptsOnly, {
      delivery: { t: DeliveryKind.Webhook, endpoint: ENDPOINT },
    });
    await world.add(receiptsOnly, events(0, 2));
    await world.compact(receiptsOnly, 'events');

    const rollUpsOnly = await listening('an ingot that only wants roll-ups', [
      DeliveryEvent.TableRolledUp,
    ]);
    await world.add(rollUpsOnly, events(0, 2));

    expect(await waiting(receiptsOnly)).toEqual([]);
    expect(await waiting(rollUpsOnly)).toEqual([]);
  });
});
