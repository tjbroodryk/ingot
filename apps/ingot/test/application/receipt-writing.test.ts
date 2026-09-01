import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind, ReceiptStatus } from '@ingot/shared/ingot-v1';
import {
  RECEIPT_SEARCH_TERM,
  RECEIPT_TABLE,
} from '../../src/contexts/records/domain/receipt-table.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The promise `receipt: "summary"` makes, kept end to end.
 *
 * The claim under test is not "an LLM was called" — the suite runs the offline
 * summariser and asserting on its prose would be asserting on a stand-in. It
 * is the loop the feature exists for: an `/add` hands back a query, a
 * background pass fills it in, and running that query later finds what was
 * stored. Everything in between — the queue, the `ingot_receipts` table, three
 * embeddings, the roll-up into Parquet — is machinery that only matters if
 * that loop closes.
 *
 * The receipt is deliberately an ordinary table, so the interesting assertions
 * are the ones that prove it really is ordinary: `/query` reads it, semantic
 * search ranks it, a roll-up does not change the answer, and no caller can
 * write to it.
 */
describe('a receipt', () => {
  let world: World;
  let ingot: string;

  const mapping = (pr: number, path: string) => ({
    table: 'pr_files',
    key: ['pr', 'path'],
    columns: {
      pr: { from: '$$.pull_request.number', type: ColumnType.Integer },
      path: { from: '$.filename', type: ColumnType.Varchar },
      patch: { from: '$.patch', type: ColumnType.Varchar },
    },
    rows: '$.files[*]',
    receipt: ReceiptKind.Full,
    // The caller's own handle — a tool call id here, which is what an agent
    // framework holds when it later wants to swap this receipt in.
    externalId: `call_${pr}`,
    result: {
      pull_request: { number: pr },
      files: [{ filename: path, patch: 'diff --git a/migrations b/migrations' }],
    },
  });

  beforeAll(async () => {
    world = await makeWorld();
  });

  beforeEach(async () => {
    ingot = await world.ingot('a memory that summarises');
    // One world across the file, and both queues are service-wide rather than
    // per-memory. Draining what earlier tests left keeps the counts below
    // about this test's own writes.
    await world.summariseAll();
    await world.embedAll();
  });

  afterAll(async () => {
    await world.close();
  });

  it('hands back where the written half will be, not the written half', async () => {
    const added = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const receipt = added.receipt;
    if (!receipt) throw new Error('no receipt');

    // Null here, and structurally so: a model is a network away and `/add`
    // returns the instant the rows are queryable. Whether it landed is a
    // question only a later read can answer.
    expect(receipt.summary).toBeNull();
    expect(receipt.searchTerm).toBeNull();
    expect(receipt.status).toBe(ReceiptStatus.Pending);
    expect(receipt.receiptQuery).toContain(RECEIPT_TABLE);

    // The compact half cotera splices over a bulky tool output is filled in
    // from the start — only the model-written fields have to wait.
    expect(receipt.externalId).toBe('call_42');
    expect(receipt.totalResults).toBe(1);
    // Named so a caller waiting on this can tell "not configured" from "not
    // run yet" without reading anybody's logs.
    expect(receipt.model).toBe('extractive-v1');
  });

  it('gives no written half, and no model, for the cheap rung', async () => {
    const added = await world.add(ingot, {
      ...mapping(7, 'src/a.ts'),
      receipt: ReceiptKind.Schema,
    });

    // `schema` costs a read; `full` costs a model. A caller who asked for the
    // first must not be charged for the second, and `status` is what says so.
    expect(added.receipt?.status).toBe(ReceiptStatus.None);
    expect(added.receipt?.receiptQuery).toBeNull();
    expect(added.receipt?.model).toBeNull();
  });

  it('leaves that query empty until the sweeper has run, then fills it', async () => {
    const added = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const query = added.receipt?.receiptQuery as string;

    // Nothing yet: the work is queued, not done. `ingot_receipts` does not even
    // exist until the first receipt is written.
    await expect(world.sql(ingot, query)).rejects.toThrow();

    expect(await world.summariseAll()).toBe(1);

    const [row] = await world.sql(ingot, query);
    expect(row).toBeDefined();
    expect(row?.source_table).toBe('pr_files');
    expect(row?.row_count).toBe(1);
    expect(String(row?.summary)).toContain('pr_files');
    expect(String(row?.search_term).length).toBeGreaterThan(0);
  });

  it('does no work for a write that did not ask for one', async () => {
    await world.add(ingot, { ...mapping(7, 'src/a.ts'), receipt: ReceiptKind.Schema });
    // The cost of a receipt is an LLM call, so it is opt-in all the way down —
    // not queued and quietly skipped, but never queued at all.
    expect(await world.summariseAll()).toBe(0);
  });

  it('embeds the summary, the search term and the body — three vectors', async () => {
    await world.add(ingot, mapping(42, 'src/engine.ts'));
    await world.summariseAll();

    // One receipt row, three embedded columns on it. The source table has no
    // embedded column at all, so every one of these belongs to the receipt.
    expect(await world.embedAll()).toBe(3);
  });

  it('is searchable by meaning, as any other table is', async () => {
    await world.add(ingot, mapping(42, 'src/engine.ts'));
    await world.add(ingot, mapping(43, 'docs/readme.md'));
    await world.summariseAll();
    await world.embedAll();

    const found = await world.query(ingot, {
      text: 'pr_files engine',
      table: RECEIPT_TABLE,
      column: RECEIPT_SEARCH_TERM,
      limit: 5,
    });

    // The point of generating a search term: a question ranks against a
    // predicted question rather than against a JSON blob.
    expect(found.rows.length).toBe(2);
  });

  it('answers the same either side of a roll-up', async () => {
    const added = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const query = added.receipt?.receiptQuery as string;
    await world.summariseAll();

    const before = await world.sql(ingot, query);
    // The whole justification for two tiers is that this changes nothing. A
    // receipt that only reads correctly out of the overlay would be a receipt
    // that expires quietly, which is worse than one that never worked.
    await world.compact(ingot, RECEIPT_TABLE);
    expect(await world.sql(ingot, query)).toEqual(before);
  });

  it('cannot be written to by a caller', async () => {
    // `ingot_receipts` is an ordinary table — that is the design, and it is
    // also why a caller's mapping could otherwise write to it and have a
    // receipt hand back a summary somebody else wrote. `SqlName.table` refuses
    // the prefix; `SqlName.systemTable` is reachable from exactly one place.
    await expect(
      world.add(ingot, {
        table: RECEIPT_TABLE,
        columns: { summary: { from: '$.text', type: ColumnType.Varchar } },
        result: { text: 'mine now' },
      }),
    ).rejects.toThrow(/ingot_/);
  });

  it('reserves the whole ingot_ namespace, not just the names in use', async () => {
    // Reserving only what exists today would make the next service-owned
    // table a breaking change for whoever had already taken its name.
    await expect(
      world.add(ingot, {
        table: 'ingot_anything',
        columns: { note: { from: '$.text', type: ColumnType.Varchar } },
        result: { text: 'mine' },
      }),
    ).rejects.toThrow(/ingot_/);

    // Columns are untouched by it: `ingot_id` is an ordinary thing to want,
    // and the namespace only ever needed protecting among tables.
    const added = await world.add(ingot, {
      table: 'notes',
      columns: { ingot_id: { from: '$.text', type: ColumnType.Varchar } },
      result: { text: 'fine' },
    });
    expect(added.rowsAdded).toBe(1);
  });

  it('keys the receipt on the batch, so a second write gets its own', async () => {
    const first = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const second = await world.add(ingot, mapping(42, 'src/engine.ts'));
    await world.summariseAll();

    const one = first.receipt?.receiptQuery as string;
    const two = second.receipt?.receiptQuery as string;

    expect(one).not.toEqual(two);
    expect(await world.sql(ingot, one)).toHaveLength(1);
    expect(await world.sql(ingot, two)).toHaveLength(1);
  });
});
