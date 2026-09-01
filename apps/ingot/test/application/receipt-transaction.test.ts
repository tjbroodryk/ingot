import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import type { Receipt, Summariser } from '../../src/ai/summariser.port.js';
import { ReceiptWorker } from '../../src/contexts/records/application/receipt-worker.js';
import { PgUnitOfWork } from '../../src/shared/infrastructure/postgres/pg-unit-of-work.js';
import { openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The model is asked with no transaction open, and this is what proves it.
 *
 * It is the reason writing a receipt is three commands rather than one.
 * `Dispatcher.send` opens a Postgres transaction around every command, so a
 * single `SummariseReceipt` would hold one of ten pooled connections for the
 * length of an LLM call. Four concurrent receipts and the pool is nearly gone —
 * and it presents as the service failing to answer requests, which sends
 * whoever is on call to look at Postgres rather than at a summary.
 *
 * Nothing about that is visible from inside the process: the fast stand-in
 * returns before anybody could notice, and the code reads the same either way.
 * So it is asserted from **outside**, on a second connection, which is the one
 * vantage point that can tell the difference — an uncommitted claim is
 * invisible to everybody else, so seeing `claimed_at` set while the model is
 * mid-call means the transaction genuinely closed first.
 *
 * The second test is what gives the first one teeth. It runs the same worker
 * inside an ambient transaction, which is exactly what dispatching it as a
 * command would do, and watches the assertion invert. Without it this file
 * would pass just as happily against a `SELECT 1`.
 *
 * Its own file because `makeWorld` truncates: a second world built inside
 * another's run takes the first one's account with it.
 */
describe('writing a receipt', () => {
  let world: World;
  let ingot: string;
  let batch = '';

  /** What a second connection could see while the model was being asked. */
  const observed: { claimed: boolean; attempts: number }[] = [];

  /** A summariser that looks around instead of summarising. */
  const watcher: Summariser = {
    model: 'watcher-v1',
    async summarise(): Promise<Receipt> {
      const { pool } = await openDatabase();
      const seen = await pool.query<{ claimed_at: Date | null; attempts: number }>(
        'SELECT claimed_at, attempts FROM overlay_receipt_queue WHERE batch = $1',
        [batch],
      );
      observed.push({
        claimed: seen.rows[0]?.claimed_at != null,
        attempts: seen.rows[0]?.attempts ?? 0,
      });
      return { summary: 'looked around', searchTerm: 'looked around' };
    },
  };

  /** Queues one receipt and returns nothing; `batch` is what the watcher reads. */
  async function queueOne(slug: string): Promise<void> {
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
    batch = added.receipt?.batch as string;
  }

  beforeAll(async () => {
    world = await makeWorld({ summariser: watcher });
    ingot = await world.ingot('a watched memory');
  });

  beforeEach(() => {
    observed.length = 0;
  });

  afterAll(async () => {
    await world.close();
  });

  it('has committed the claim, and let go of the connection, before asking', async () => {
    await queueOne('watched');

    expect(await world.summariseAll()).toBe(1);

    expect(observed).toEqual([
      {
        // Visible to a connection that is not ours, so the claim committed.
        claimed: true,
        // Counted by the claim rather than by the failure handler. A worker
        // killed by the very body it is describing never reaches a failure
        // handler, so a counter written there would sit at zero for ever —
        // and that body would be retried for ever with it.
        attempts: 1,
      },
    ]);
  });

  it('would not have, if it were dispatched as one command', async () => {
    await queueOne('smothered');

    // `PgUnitOfWork.run` joins an open scope rather than nesting, so running
    // the worker inside one is precisely what a single `SummariseReceipt`
    // command would be: all three steps in the caller's transaction, the model
    // asked while it is open. This is the shape the split exists to prevent.
    const uow = world.app.get(PgUnitOfWork, { strict: false });
    const worker = world.app.get(ReceiptWorker, { strict: false });
    await uow.run(() => worker.next());

    expect(observed).toEqual([
      {
        // Nothing outside the transaction can see the claim, which is the same
        // thing as saying the connection is still held. If this ever reads
        // `true`, the test above has stopped proving anything.
        claimed: false,
        attempts: 0,
      },
    ]);
  });
});
