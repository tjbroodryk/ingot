import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, type QueryBody, type QueryResult } from '@ingot/shared/ingot-v1';
import { MAX_QUERY_OFFSET } from '../../src/contexts/query/application/queries/query-ingot.query.js';
import { QueryCursor } from '../../src/contexts/query/application/query-cursor.js';
import { InvariantViolation } from '../../src/shared/domain/index.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A result longer than `limit`, read a page at a time.
 *
 * Asserted with nothing written between pages, which is the only case a cursor
 * promises anything about: it is an offset, and a write in between moves rows
 * the way it would under `LIMIT … OFFSET` anywhere else.
 */
describe('paging a query', () => {
  let world: World;
  let ingot: string;

  /** Every page of a query, following `next` until there is none. */
  const pages = async (body: QueryBody): Promise<QueryResult[]> => {
    const read: QueryResult[] = [];
    let cursor: string | undefined;
    do {
      const page = await world.query(ingot, { ...body, cursor });
      read.push(page);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined && read.length < 20);
    return read;
  };

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('an ingot worth paging');
    await world.add(ingot, {
      table: 'events',
      rows: '$.items[*]',
      columns: {
        n: { from: '$.n', type: ColumnType.Integer },
        note: { from: '$.note', type: ColumnType.Varchar, embed: true },
      },
      result: {
        items: Array.from({ length: 25 }, (_, n) => ({ n, note: `event number ${n}` })),
      },
    });
    await world.embedAll();
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('follows next through every row, once each', async () => {
    const read = await pages({ sql: 'SELECT n FROM events ORDER BY n', limit: 10 });

    expect(read.map((page) => page.rows.length)).toEqual([10, 10, 5]);
    expect(read.flatMap((page) => page.rows.map((row) => row.n))).toEqual(
      Array.from({ length: 25 }, (_, n) => n),
    );
    expect(read.map((page) => page.truncated)).toEqual([true, true, false]);
    expect(read.at(-1)?.next).toBeNull();
  });

  it('ends on a full page when the rows run out exactly there', async () => {
    const read = await pages({ sql: 'SELECT n FROM events WHERE n < 20 ORDER BY n', limit: 10 });

    expect(read.map((page) => page.rows.length)).toEqual([10, 10]);
    expect(read.at(-1)?.next).toBeNull();
  });

  it('pages a search in words, which used to stop at the first page', async () => {
    const read = await pages({ text: 'event number', table: 'events', limit: 10 });

    const ids = read.flatMap((page) => page.rows.map((row) => row._row_id));
    expect(ids.length).toBe(25);
    expect(new Set(ids).size).toBe(25);

    const scores = read.flatMap((page) => page.rows.map((row) => Number(row.score)));
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('refuses a cursor sent with a different query', async () => {
    const first = await world.query(ingot, { sql: 'SELECT n FROM events ORDER BY n', limit: 5 });
    expect(first.next).not.toBeNull();

    await expect(
      world.query(ingot, {
        sql: 'SELECT n FROM events ORDER BY n DESC',
        cursor: first.next ?? undefined,
      }),
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('refuses a cursor it did not issue', async () => {
    await expect(
      world.query(ingot, { sql: 'SELECT n FROM events', cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('refuses to reach further in than a page may re-read', async () => {
    const body = { sql: 'SELECT n FROM events ORDER BY n' };
    await expect(
      world.query(ingot, { ...body, cursor: QueryCursor.encode(body, MAX_QUERY_OFFSET + 1) }),
    ).rejects.toBeInstanceOf(InvariantViolation);
  });
});
