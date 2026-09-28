import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import { MAX_FILE_ATTEMPTS } from '../../src/contexts/files/application/commands/claim-file.command.js';
import {
  FILE_QUEUE,
  type FileQueue,
} from '../../src/contexts/files/application/ports/file-queue.port.js';
import { MAX_RECEIPT_ATTEMPTS } from '../../src/contexts/records/application/commands/claim-receipt.command.js';
import {
  DELIVERY_OUTBOX,
  type DeliveryOutbox,
} from '../../src/contexts/records/application/ports/delivery-outbox.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../src/contexts/records/application/ports/overlay-store.port.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/** The queries behind `ingot_background_oldest_pending_seconds`. */
describe('how far behind a background queue is', () => {
  let world: World;
  let ingot: string;
  let overlay: OverlayStore;

  const note = {
    table: 'notes',
    columns: { body: { from: '$.body', type: ColumnType.Varchar, embed: true } },
    receipt: ReceiptKind.Full,
    result: { body: 'the migration broke on a missing index' },
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a lagging ingot');
    overlay = world.app.get<OverlayStore>(OVERLAY_STORE, { strict: false });
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('reads 0 for every queue when nothing is waiting', async () => {
    const outbox = world.app.get<DeliveryOutbox>(DELIVERY_OUTBOX, { strict: false });
    const files = world.app.get<FileQueue>(FILE_QUEUE, { strict: false });

    expect(await overlay.oldestPendingSeconds()).toBe(0);
    expect(await overlay.oldestReceiptSeconds(MAX_RECEIPT_ATTEMPTS)).toBe(0);
    expect(await outbox.oldestPendingSeconds(4)).toBe(0);
    expect(await files.oldestPendingSeconds(MAX_FILE_ATTEMPTS)).toBe(0);
  });

  it('ages from the oldest queued item, by the database clock', async () => {
    await world.add(ingot, note);
    const { pool } = await openDatabase();
    await pool.query(`UPDATE overlay_embed_queue SET queued_at = now() - interval '90 seconds'`);
    await pool.query(`UPDATE overlay_receipt_queue SET queued_at = now() - interval '90 seconds'`);

    const embedding = await overlay.oldestPendingSeconds();
    const receipt = await overlay.oldestReceiptSeconds(MAX_RECEIPT_ATTEMPTS);

    expect(embedding).toBeGreaterThanOrEqual(90);
    expect(embedding).toBeLessThan(120);
    expect(receipt).toBeGreaterThanOrEqual(90);
    expect(receipt).toBeLessThan(120);
  });

  // An abandoned receipt will never clear, so counting it would pin the lag
  // high for good and read as a queue that needs more pods.
  it('leaves out what has run out of attempts', async () => {
    const { pool } = await openDatabase();
    await pool.query('UPDATE overlay_receipt_queue SET attempts = $1', [MAX_RECEIPT_ATTEMPTS]);

    expect(await overlay.oldestReceiptSeconds(MAX_RECEIPT_ATTEMPTS)).toBe(0);
  });
});
