import { describe, expect, it } from 'bun:test';
import { ColumnType, ConflictError, ReceiptKind, TimeoutError, col, table } from '../src/index.js';
import { bodyOf, client, json } from './support.js';

const tickets = table('tickets')
  .rows('$.items[*]')
  .columns({
    id: col.varchar('$.id'),
    title: col.varchar('$.title').embed(),
    source: col.varchar.value('github'),
  })
  .key('id');

const pendingPage = (overrides: Record<string, unknown> = {}) => ({
  table: 'tickets',
  generation: 3,
  base: [{ part: 1, rows: 10, bytes: 2048 }],
  rows: [],
  tombstones: [],
  next: null,
  ...overrides,
});

const info = {
  id: 'ing_1',
  name: 'chat',
  externalId: null,
  account: 'acme',
  createdAt: '',
  expiresAt: null,
  embedding: null,
  config: { delivery: { t: 'none' }, expiresAt: null },
  tables: [
    {
      name: 'tickets',
      columns: [
        { name: '_row_id', type: 'VARCHAR', embedded: false, required: true },
        { name: 'id', type: 'VARCHAR', embedded: false, required: true },
      ],
      key: ['id'],
      rows: 10,
      pending: 2,
      generation: 3,
      config: {},
    },
  ],
};

describe('Memory', () => {
  it('adds through a table definition', async () => {
    const { ingot, requests } = client(() => json({ table: 'tickets', rowsAdded: 1 }));
    await ingot
      .memory('ing_1')
      .add(
        tickets,
        { items: [{ id: 'T-1' }] },
        { receipt: ReceiptKind.Full, externalId: 'call_1' },
      );

    expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/ing_1/add');
    expect(bodyOf(requests[0] as never)).toEqual({
      table: 'tickets',
      rows: '$.items[*]',
      columns: {
        id: { type: 'VARCHAR', from: '$.id' },
        title: { type: 'VARCHAR', from: '$.title', embed: true },
        source: { type: 'VARCHAR', value: 'github' },
      },
      key: ['id'],
      receipt: 'full',
      externalId: 'call_1',
      result: { items: [{ id: 'T-1' }] },
    });
  });

  it('uploads a document as multipart, options as one JSON part', async () => {
    const { ingot, requests } = client(() => json({ fileId: 'file_1' }, 201));
    const contracts = table('contracts').columns({
      notice: col.integer().describe('Notice period in days'),
    });
    await ingot.memory('ing_1').uploadDocument(new Uint8Array([37, 80, 68, 70]), {
      filename: 'msa.pdf',
      mediaType: 'application/pdf',
      extract: contracts,
    });

    const form = requests[0]?.body as FormData;
    expect(requests[0]?.headers['content-type']).toBeUndefined();
    const file = form.get('file') as File;
    expect(file.name).toBe('msa.pdf');
    expect(JSON.parse(String(form.get('body')))).toEqual({
      mediaType: 'application/pdf',
      extract: {
        table: 'contracts',
        columns: { notice: { type: 'INTEGER', describe: 'Notice period in days' } },
      },
    });
  });

  it('leaves the body part out when there are no options', async () => {
    const { ingot, requests } = client(() => json({ fileId: 'file_1' }, 201));
    await ingot.memory('ing_1').uploadDocument(new File(['# hi'], 'notes.md'));
    const form = requests[0]?.body as FormData;
    expect(form.has('body')).toBe(false);
    expect(() => ingot.memory('ing_1').uploadDocument(new Uint8Array([1]))).toThrow(TypeError);
  });

  it('follows query cursors to the end', async () => {
    const { ingot, requests } = client((_r, index) =>
      json({
        columns: ['n'],
        rows: [{ n: index }],
        truncated: index < 2,
        next: index < 2 ? `c${index}` : null,
        elapsedMs: 1,
      }),
    );
    const pages = [];
    for await (const page of ingot.memory('ing_1').queryPages<{ n: number }>('SELECT n FROM t')) {
      pages.push(page.rows[0]?.n);
    }
    expect(pages).toEqual([0, 1, 2]);
    expect(requests.map((r) => bodyOf(r))).toEqual([
      { sql: 'SELECT n FROM t' },
      { sql: 'SELECT n FROM t', cursor: 'c0' },
      { sql: 'SELECT n FROM t', cursor: 'c1' },
    ]);
  });

  it('searches a typed table by one of its embedded columns', async () => {
    const { ingot, requests } = client(() =>
      json({ columns: [], rows: [], truncated: false, next: null, elapsedMs: 1 }),
    );
    await ingot.memory('ing_1').table(tickets).search('refund', { column: 'title', limit: 5 });
    expect(bodyOf(requests[0] as never)).toEqual({
      text: 'refund',
      column: 'title',
      limit: 5,
      table: 'tickets',
    });
  });

  it('passes a range read through and hands back the response untouched', async () => {
    const { ingot, requests } = client(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-2/10' },
        }),
    );
    const response = await ingot
      .memory('ing_1')
      .table('tickets')
      .parquet({ generation: 3, part: 1, range: 'bytes=0-2' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-2/10');
    expect(requests[0]?.url).toBe(
      'https://ingot.test/api/v1/acme/ing_1/tables/tickets/parquet?generation=3&part=1',
    );
    expect(requests[0]?.headers.range).toBe('bytes=0-2');
  });

  it('snapshots every pending page against one generation, then the columns', async () => {
    const row = (seq: string) => ({ rowId: `r${seq}`, seq, ingestedAt: '', values: { id: seq } });
    const { ingot, requests } = client((request) => {
      if (request.url.endsWith('/info')) return json(info);
      if (!request.url.includes('after=')) {
        return json(pendingPage({ rows: [row('1')], next: '1' }));
      }
      return json(pendingPage({ rows: [row('2')], tombstones: [{ rowId: 'r0', at: '' }] }));
    });

    const snapshot = await ingot.memory('ing_1').table('tickets').snapshot();
    expect(snapshot.generation).toBe(3);
    expect(snapshot.rows.map((r) => r.seq)).toEqual(['1', '2']);
    expect(snapshot.tombstones).toEqual([{ rowId: 'r0', at: '' }]);
    expect(snapshot.cursor).toBe('2');
    expect(snapshot.columns.map((c) => c.name)).toEqual(['_row_id', 'id']);
    expect(requests.at(-1)?.url).toEndWith('/info');
  });

  it('starts a snapshot over when a roll-up lands between pages, and gives up eventually', async () => {
    let generation = 3;
    const { ingot } = client((request) => {
      if (request.url.endsWith('/info')) return json(info);
      if (!request.url.includes('after=')) return json(pendingPage({ generation, next: '1' }));
      generation += 1;
      return json(pendingPage({ generation }));
    });
    const error = await ingot
      .memory('ing_1')
      .table('tickets')
      .snapshot({ maxRestarts: 2 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);

    let calls = 0;
    const settles = client((request) => {
      if (request.url.endsWith('/info')) return json(info);
      calls += 1;
      if (calls === 1) return json(pendingPage({ generation: 3, next: '1' }));
      if (calls === 2) return json(pendingPage({ generation: 4 }));
      return json(pendingPage({ generation: 4 }));
    });
    expect((await settles.ingot.memory('ing_1').table('tickets').snapshot()).generation).toBe(4);
  });

  it('waits for a document, treating a table that does not exist yet as not ready', async () => {
    const { ingot } = client((_r, index) => {
      if (index === 0) {
        return json({ message: 'Catalog Error: Table with name ingot_files does not exist!' }, 422);
      }
      if (index === 1)
        return json({ columns: [], rows: [], truncated: false, next: null, elapsedMs: 1 });
      return json({
        columns: [],
        rows: [{ file_id: 'file_1', status: 'ready' }],
        truncated: false,
        next: null,
        elapsedMs: 1,
      });
    });
    const row = await ingot
      .memory('ing_1')
      .waitForDocument({ fileId: 'file_1', query: 'SELECT 1' }, { intervalMs: 1 });
    expect(row.status).toBe('ready');
  });

  it('gives up waiting for a receipt that never lands', async () => {
    const { ingot } = client(() =>
      json({ columns: [], rows: [], truncated: false, next: null, elapsedMs: 1 }),
    );
    const added = { receipt: { receiptQuery: 'SELECT 1', batch: 'b' } } as never;
    const error = await ingot
      .memory('ing_1')
      .waitForReceipt(added, { intervalMs: 5, timeoutMs: 20 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it('clones into a handle on the copy, retrying only when keyed', async () => {
    const copy = { ...info, id: 'ing_2', name: 'fork', tables: 1, rows: 10 };
    const { ingot, requests } = client((_, index) =>
      index === 0 ? json({ message: 'down' }, 503) : json(copy, 201),
    );

    const clone = await ingot.memory('ing_1').clone({ name: 'fork', externalId: 'fork-1' });
    expect(clone.id).toBe('ing_2');
    expect(clone.summary?.name).toBe('fork');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('https://ingot.test/api/v1/acme/ing_1/clone');
    expect(bodyOf(requests[1] as never)).toEqual({ name: 'fork', externalId: 'fork-1' });

    const unkeyed = client(() => json({ message: 'down' }, 503));
    await expect(unkeyed.ingot.memory('ing_1').clone()).rejects.toThrow();
    expect(unkeyed.requests).toHaveLength(1);
    expect(bodyOf(unkeyed.requests[0] as never)).toEqual({});
  });

  it('configures expiry and delivery in one patch', async () => {
    const { ingot, requests } = client(() => json({ delivery: { t: 'none' }, expiresAt: null }));
    await ingot.memory('ing_1').configure({ retainFor: null });
    expect(bodyOf(requests[0] as never)).toEqual({ retainFor: null });
    expect(ColumnType.Varchar).toBe('VARCHAR' as never);
  });
});
