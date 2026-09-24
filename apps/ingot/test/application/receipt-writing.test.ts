import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind, ReceiptStatus } from '@ingot/shared/ingot-v1';
import {
  RECEIPT_SEARCH_TERM,
  RECEIPT_TABLE,
} from '../../src/contexts/records/domain/receipt-table.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * `receipt: "summary"` end to end: `/add` hands back a query, a background pass
 * fills it in, and the receipt is an ordinary table nobody else can write to.
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
    // The caller's own handle, echoed back on the receipt.
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
    // Both queues are service-wide; drain what earlier tests left so the counts
    // below cover only this test's writes.
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

    // Null: `/add` returns as soon as the rows are queryable, before the model runs.
    expect(receipt.summary).toBeNull();
    expect(receipt.searchTerm).toBeNull();
    expect(receipt.status).toBe(ReceiptStatus.Pending);
    expect(receipt.receiptQuery).toContain(RECEIPT_TABLE);

    // Non-model fields are filled from the start; only the model-written ones wait.
    expect(receipt.externalId).toBe('call_42');
    expect(receipt.totalResults).toBe(1);
    // Named up front, so "not configured" reads differently from "not run yet".
    expect(receipt.model).toBe('extractive-v1');
  });

  it('gives no written half, and no model, for the cheap rung', async () => {
    const added = await world.add(ingot, {
      ...mapping(7, 'src/a.ts'),
      receipt: ReceiptKind.Schema,
    });

    // `schema` costs a read, `full` a model; asking for the first does not run the second.
    expect(added.receipt?.status).toBe(ReceiptStatus.None);
    expect(added.receipt?.receiptQuery).toBeNull();
    expect(added.receipt?.model).toBeNull();
  });

  it('leaves that query empty until the sweeper has run, then fills it', async () => {
    const added = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const query = added.receipt?.receiptQuery as string;

    // Queued, not done; `ingot_receipts` does not exist until the first receipt is written.
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
    // Never queued at all, not queued and skipped.
    expect(await world.summariseAll()).toBe(0);
  });

  it('embeds the summary, the search term and the body — three vectors', async () => {
    await world.add(ingot, mapping(42, 'src/engine.ts'));
    await world.summariseAll();

    // Three embedded columns, all on the receipt; the source table has none.
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

    expect(found.rows.length).toBe(2);
  });

  it('answers the same either side of a roll-up', async () => {
    const added = await world.add(ingot, mapping(42, 'src/engine.ts'));
    const query = added.receipt?.receiptQuery as string;
    await world.summariseAll();

    const before = await world.sql(ingot, query);
    // A roll-up must not change the answer.
    await world.compact(ingot, RECEIPT_TABLE);
    expect(await world.sql(ingot, query)).toEqual(before);
  });

  it('cannot be written to by a caller', async () => {
    // `SqlName.table` refuses the `ingot_` prefix; only `SqlName.systemTable`
    // bypasses it.
    await expect(
      world.add(ingot, {
        table: RECEIPT_TABLE,
        columns: { summary: { from: '$.text', type: ColumnType.Varchar } },
        result: { text: 'mine now' },
      }),
    ).rejects.toThrow(/ingot_/);
  });

  it('reserves the whole ingot_ namespace, not just the names in use', async () => {
    // The whole `ingot_` prefix is reserved, not only the names in use.
    await expect(
      world.add(ingot, {
        table: 'ingot_anything',
        columns: { note: { from: '$.text', type: ColumnType.Varchar } },
        result: { text: 'mine' },
      }),
    ).rejects.toThrow(/ingot_/);

    // Columns are untouched: the prefix is reserved only among table names.
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
