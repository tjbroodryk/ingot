import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import {
  EMBEDDING_SERVICE,
  RECEIPT_SERVICE,
  RUN_NOW,
} from '../../src/contexts/records/application/background.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * What `/add` tells the background, and whether it tells it at all.
 *
 * This used to be untestable, which is why it is being written now. The suite
 * disabled durable sends with `RESTATE_ENABLED=false`, so the branch that
 * dropped them ran in every test and the branch that made them ran in none —
 * and the flag documented itself as a deployment shape, which two sweepers
 * then cited in their comments as the topology they existed to cover. Nobody
 * deploys that. The send is now bound out in the harness instead, so the
 * production path has no branch in it and this file can watch it work.
 *
 * The failure it guards against is quiet in the way this service's failures
 * usually are. A trigger that stops being sent costs nothing visible: the rows
 * commit, `/add` answers, the receipt hands back a query that works. The only
 * symptom is that a row is findable by meaning a minute later instead of
 * immediately — a latency regression with no error, no log line, and nothing
 * that fails until somebody times it.
 */
describe('what a write sets off', () => {
  let world: World;
  let ingot: string;

  const embedded = {
    table: 'notes',
    columns: {
      body: { from: '$.body', type: ColumnType.Varchar, embed: true },
    },
  };

  const plain = {
    table: 'plain_notes',
    columns: {
      body: { from: '$.body', type: ColumnType.Varchar },
    },
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory with a background');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('tells the embedding sweeper the moment a write queues work', async () => {
    const before = world.sends.length;

    const added = await world.add(ingot, {
      ...embedded,
      result: { body: 'the migration broke on a missing index' },
    });

    expect(added.queuedForEmbedding).toBeGreaterThan(0);

    const sent = world.sends.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.service).toBe(EMBEDDING_SERVICE);
    // `now`, never `tick`: `tick` books the next cron tick as its last act, so
    // triggering that per write would give a busy memory one chain per `/add`,
    // each booking another, for ever.
    expect(sent[0]?.handler).toBe(RUN_NOW);
  });

  it('keys the send on the batch, so a resend is one invocation', async () => {
    const before = world.sends.length;

    await world.add(ingot, { ...embedded, result: { body: 'a second note' } });
    await world.add(ingot, { ...embedded, result: { body: 'a third note' } });

    const keys = world.sends.slice(before).map((each) => each.idempotencyKey);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    // Distinct per write, or the second `/add` of a run would be collapsed
    // into the first by Restate and its rows would wait for a tick.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('says nothing when a write queued nothing', async () => {
    const before = world.sends.length;

    const added = await world.add(ingot, {
      ...plain,
      result: { body: 'nothing here is embedded' },
    });

    expect(added.queuedForEmbedding).toBe(0);
    expect(world.sends.slice(before)).toEqual([]);
  });

  it('tells the receipt sweeper only when a receipt was asked for', async () => {
    const before = world.sends.length;

    await world.add(ingot, {
      ...plain,
      receipt: ReceiptKind.Schema,
      result: { body: 'a schema receipt is built inline' },
    });
    expect(world.sends.slice(before)).toEqual([]);

    await world.add(ingot, {
      ...plain,
      receipt: ReceiptKind.Full,
      result: { body: 'a full receipt is written in the background' },
    });

    const sent = world.sends.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.service).toBe(RECEIPT_SERVICE);
    expect(sent[0]?.handler).toBe(RUN_NOW);
  });

  it('sends after the commit, not inside it', async () => {
    const before = world.sends.length;

    await world.add(ingot, {
      ...embedded,
      result: { body: 'a note whose rows must exist by the time anyone is told' },
    });

    // The rows the send is about are readable from outside the transaction by
    // the time it goes. Sending from inside would announce work a rollback
    // could still take away, and the sweeper would go looking for a queue row
    // that never existed.
    expect(world.sends.length).toBe(before + 1);
    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});
