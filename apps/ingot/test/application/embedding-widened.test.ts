import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Widening a column to `embed` works forwards and only forwards.
 *
 * This is a *shortcoming pinned in place*, not a property anybody wanted. It is
 * here because `IngotTable.accommodate` carried a comment claiming the sweeper
 * backfilled these rows, and nothing asserted it — so the comment was wrong for
 * as long as it existed, and the code read as though the case were handled.
 * `OverlayStore.append` queues the rows of the write it is given, and that is
 * the only way into `overlay_embed_queue`.
 *
 * The failure it describes is silent the whole way down: no error, and
 * `ingot_embeddings_pending` counts the queue rather than un-embedded rows, so
 * the gauge reads zero while a semantic search over the table returns only what
 * arrived after the flip.
 *
 * **When the backfill lands, this test fails, and that is the point.** Rewrite
 * it then to assert the rows left behind are picked up — and the comment in the
 * aggregate and the section in `README.md` move with it, which is the drift
 * this exists to catch.
 *
 * Its own file because `makeWorld` truncates: a second world built inside
 * another's run takes the first one's account with it.
 */
describe('turning embedding on after the fact', () => {
  let world: World;
  let ingot: string;

  const body = { from: '$.body', type: ColumnType.Varchar };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory that changed its mind');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('embeds what comes after, and leaves what came before', async () => {
    // Written while the column was plain: nothing queued, no vector.
    const before = await world.add(ingot, {
      table: 'notes',
      columns: { body },
      result: { body: 'stored before anybody wanted this searchable' },
    });
    expect(before.queuedForEmbedding).toBe(0);

    // The widening. Accepted rather than refused — a table that can never gain
    // a searchable column would be worse — and it takes effect from here.
    const after = await world.add(ingot, {
      table: 'notes',
      columns: { body: { ...body, embed: true } },
      result: { body: 'stored once somebody did' },
    });
    expect(after.queuedForEmbedding).toBe(1);

    // One row embedded out of the two that are there. The first is not queued,
    // not pending, and not coming.
    expect(await world.embedAll()).toBe(1);
    expect(await world.embedAll()).toBe(0);

    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');
    expect(Number(rows[0]?.n)).toBe(2);
  });

  /**
   * The flag is the table's, so a later write that does not repeat it is still
   * embedded. That is the half of this design the docs were understating, and
   * it is worth holding separately from the shortcoming above.
   */
  it('keeps embedding without being asked again', async () => {
    const quiet = await world.add(ingot, {
      table: 'notes',
      columns: { body },
      result: { body: 'no embed flag on this write at all' },
    });

    expect(quiet.queuedForEmbedding).toBe(1);
    expect(await world.embedAll()).toBe(1);
  });
});
