import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, ReceiptKind } from '@ingot/shared/ingot-v1';
import { MAX_RECEIPT_ITEMS } from '../../src/contexts/records/application/receipt-builder.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * What an `/add` says back, and whether it is true.
 *
 * A receipt's whole value is that the queries in it work. Asserting their
 * *text* would pass for a receipt that is confidently wrong, so every
 * assertion below runs the query it is checking and looks at what comes back.
 */
let world: World;

beforeAll(async () => {
  world = await makeWorld();
});

afterAll(async () => {
  await world?.close();
  await closeDatabase();
});

describe('a receipt', () => {
  let ingot: string;

  const files = (pr: number, names: readonly string[]) => ({
    pull_request: { number: pr },
    files: names.map((name, index) => ({ filename: name, additions: index + 1 })),
  });

  const mapping = (pr: number, names: readonly string[]) => ({
    table: 'pr_files',
    rows: '$.files[*]',
    key: ['pr', 'path'],
    columns: {
      pr: { from: '$$.pull_request.number', type: ColumnType.Integer },
      path: { from: '$.filename', type: ColumnType.Varchar },
      adds: { from: '$.additions', type: ColumnType.Integer },
    },
    receipt: ReceiptKind.Schema,
    result: files(pr, names),
  });

  beforeAll(async () => {
    ingot = await world.ingot('a memory with receipts');
  });

  it('is not produced unless asked for', async () => {
    const added = await world.add(ingot, { ...mapping(1, ['a.ts']), receipt: undefined });
    expect(added.receipt).toBeUndefined();
    expect(added.rowsAdded).toBe(1);
  });

  it('hands back a batch query that returns exactly what this call wrote', async () => {
    // Two rows here, one row already in the table from the test above — so a
    // query that returned "everything" would pass a weaker assertion.
    const added = await world.add(ingot, mapping(42, ['src/engine.ts', 'README.md']));
    const receipt = added.receipt;
    if (!receipt) throw new Error('no receipt');

    const rows = await world.sql(ingot, receipt.query);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.path).sort()).toEqual(['README.md', 'src/engine.ts']);
  });

  it('hands back a query per row, on the caller’s own key', async () => {
    const added = await world.add(ingot, mapping(43, ['one.ts', 'two.ts']));
    const receipt = added.receipt;
    if (!receipt) throw new Error('no receipt');

    expect(receipt.key).toEqual(['pr', 'path']);
    expect(receipt.items).toHaveLength(2);
    expect(receipt.itemsTruncated).toBe(false);

    for (const item of receipt.items) {
      const rows = await world.sql(ingot, item.query);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pr: item.key.pr, path: item.key.path });
    }
  });

  /**
   * The reason a caller-declared key is worth having at all.
   *
   * A `_batch` or `_row_id` query finds what was written *this time*. A key
   * query finds the thing — including the copy stored later, which is what an
   * agent re-reading the same file actually produces.
   */
  it('still finds the item after the same item is stored again', async () => {
    const first = await world.add(ingot, mapping(50, ['stable.ts']));
    const item = first.receipt?.items[0];
    if (!item) throw new Error('no item');

    expect(await world.sql(ingot, item.query)).toHaveLength(1);

    await world.add(ingot, mapping(50, ['stable.ts']));

    // Two rows now — the key identifies the thing, it does not deduplicate it,
    // and the contract says so. The batch query from the first write would
    // still return only one.
    expect(await world.sql(ingot, item.query)).toHaveLength(2);
    expect(await world.sql(ingot, first.receipt?.query as string)).toHaveLength(1);
  });

  it('falls back to _row_id when the table declares no key', async () => {
    const added = await world.add(ingot, {
      table: 'unkeyed',
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      receipt: ReceiptKind.Schema,
      result: { body: 'no key here' },
    });
    const receipt = added.receipt;
    if (!receipt) throw new Error('no receipt');

    expect(receipt.key).toEqual([]);
    expect(Object.keys(receipt.items[0]?.key ?? {})).toEqual(['_row_id']);

    const rows = await world.sql(ingot, receipt.items[0]?.query as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('no key here');
  });

  it('reports the schema the write left behind, key included', async () => {
    const added = await world.add(ingot, {
      ...mapping(60, ['later.ts']),
      columns: { ...mapping(60, []).columns, status: { value: 'open', type: ColumnType.Varchar } },
    });

    expect(added.columnsAdded).toEqual(['status']);
    // The receipt describes the table *after* the write, so the column this
    // call introduced is in it — which is the point of building it afterwards.
    expect(added.receipt?.table.columns.map((column) => column.name)).toContain('status');
    expect(added.receipt?.table.key).toEqual(['pr', 'path']);
  });

  it('caps the per-row queries and says it did', async () => {
    const names = Array.from({ length: MAX_RECEIPT_ITEMS + 20 }, (_, n) => `f${n}.ts`);
    const added = await world.add(ingot, mapping(70, names));

    expect(added.rowsAdded).toBe(names.length);
    expect(added.receipt?.items).toHaveLength(MAX_RECEIPT_ITEMS);
    // Said rather than silently short: a caller reading 100 items would
    // otherwise take them for all of them.
    expect(added.receipt?.itemsTruncated).toBe(true);

    // …and the batch query still covers every row.
    expect(await world.sql(ingot, added.receipt?.query as string)).toHaveLength(names.length);
  });
});

describe('declaring a key', () => {
  // The same world as above: `closeDatabase` ends a pool every world in the
  // process shares, so a file builds one and hands out ingots from it.
  let ingot: string;

  beforeAll(async () => {
    ingot = await world.ingot('a memory to key');
    await world.add(ingot, {
      table: 'notes',
      key: ['slug'],
      columns: {
        slug: { from: '$.slug', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar },
      },
      result: { slug: 'first', body: 'hello' },
    });
  });

  it('refuses a key naming a column the mapping does not fill', async () => {
    const wrong = world.add(ingot, {
      table: 'other',
      key: ['nope'],
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      result: { body: 'x' },
    });
    await expect(wrong).rejects.toThrow(/does not fill/);
  });

  it('refuses a key that names the same column twice', async () => {
    const wrong = world.add(ingot, {
      table: 'twice',
      key: ['body', 'body'],
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      result: { body: 'x' },
    });
    await expect(wrong).rejects.toThrow(/appears twice/);
  });

  it('refuses a later write that changes what identifies a row', async () => {
    // Every receipt already handed out was written against the old key.
    const changed = world.add(ingot, {
      table: 'notes',
      key: ['body'],
      columns: {
        slug: { from: '$.slug', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar },
      },
      result: { slug: 'second', body: 'x' },
    });
    await expect(changed).rejects.toThrow(/key cannot change/);
  });

  it('accepts a later write that names no key at all', async () => {
    // Omitting is not contradicting.
    const added = await world.add(ingot, {
      table: 'notes',
      columns: {
        slug: { from: '$.slug', type: ColumnType.Varchar },
        body: { from: '$.body', type: ColumnType.Varchar },
      },
      receipt: ReceiptKind.Schema,
      result: { slug: 'third', body: 'y' },
    });
    expect(added.receipt?.key).toEqual(['slug']);
  });

  it('refuses an unknown receipt kind before writing anything', async () => {
    const before = await world.sql(ingot, 'SELECT count(*) AS n FROM notes');

    await expect(
      world.add(ingot, {
        table: 'notes',
        columns: { slug: { from: '$.slug', type: ColumnType.Varchar } },
        receipt: 'everything' as never,
        result: { slug: 'nope' },
      }),
    ).rejects.toThrow(/receipt/);

    // Parsed before the write, so a bad value costs nothing.
    expect(await world.sql(ingot, 'SELECT count(*) AS n FROM notes')).toEqual(before);
  });
});
