import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import type { Receipt, Summariser } from '../../src/ai/summariser.port.js';
import { ReceiptWorker } from '../../src/contexts/records/application/receipt-worker.js';
import { PgUnitOfWork } from '../../src/shared/infrastructure/postgres/pg-unit-of-work.js';
import { openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The summariser is asked with no transaction open, so the claim commits and
 * the connection is released before the model call. Asserted from a second
 * connection, which alone can see whether the claim has committed.
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
        // Visible to another connection, so the claim committed.
        claimed: true,
        // Counted at claim, not in the failure handler.
        attempts: 1,
      },
    ]);
  });

  it('would not have, if it were dispatched as one command', async () => {
    await queueOne('smothered');

    // `PgUnitOfWork.run` joins an open scope rather than nesting, so running the
    // worker inside one asks the model with the transaction still open.
    const uow = world.app.get(PgUnitOfWork, { strict: false });
    const worker = world.app.get(ReceiptWorker, { strict: false });
    await uow.run(() => worker.next());

    expect(observed).toEqual([
      {
        // The claim is invisible outside the transaction, so the connection is
        // still held.
        claimed: false,
        attempts: 0,
      },
    ]);
  });
});
