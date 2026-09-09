import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, FileStatus } from '@ingot/shared/ingot-v1';
import { BackgroundKind } from '../../src/contexts/records/application/background.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

const HANDBOOK = `# Acme Engineering Handbook

Welcome to the handbook.

## 2 Deployment

Everything ships through the pipeline.

### 2.2 Rollback

Any engineer may roll back without approval. It takes ninety seconds.

## 3 On-call

### 3.1 Notice period

An on-call swap requires thirty days of written notice.
`;

const INVOICES = `Invoice #,Vendor,Amount,Notes
ACME-4471,"Acme Corp, Ltd",18400,"Annual licence renewal, includes support"
BOLT-0012,Bolt Supplies,2350,Replacement parts
CRUX-9903,Crux Analytics,41200,"Data platform, three-year term"
`;

/**
 * `/file` end to end: bytes in, rows out, queryable beside everything else.
 *
 * The property under all of it is that **a document becomes ordinary tables**.
 * Nothing here reaches for a document API, a chunk endpoint or a second reader
 * — every assertion is a `SELECT`, because that is the whole claim.
 */
describe('storing a document', () => {
  let world: World;

  beforeAll(async () => {
    world = await makeWorld();
  });

  afterAll(async () => {
    await world.close();
    await closeDatabase();
  });

  describe('accepting it', () => {
    it('returns before the document has been read, and says so', async () => {
      const ingot = await world.ingot();
      const accepted = await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });

      // Always pending, and it cannot be anything else: the response is sent
      // before a byte has been parsed. The queries are the promissory note.
      expect(accepted.status).toBe(FileStatus.Pending);
      expect(accepted.fileId).toStartWith('file_');
      expect(accepted.query).toContain('ingot_files');
      expect(accepted.chunksQuery).toContain('ingot_chunks');

      // Nothing exists yet — not an empty table, no table at all, because a
      // table here is declared by the write that fills it. That is the honest
      // state and the same one a pending receipt leaves behind.
      await expect(world.sql(ingot, 'SELECT * FROM ingot_files')).rejects.toThrow(
        /no tables yet/,
      );
    });

    it('wakes the parser rather than leaving it for the next tick', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, { filename: 'a.txt', mediaType: 'text/plain', content: 'hello' });

      // A minute of latency on a document somebody is waiting for is a minute
      // they experience. The sweeper stays as the floor under a wake that
      // never happened.
      expect(world.wakes).toContain(BackgroundKind.Files);
    });
  });

  describe('reading it', () => {
    it('writes chunks that carry the heading path they were found under', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });
      // Drains everything queued, not only this document — one world is shared
      // across the file, and asserting a count here would be asserting on what
      // the tests above happened to leave behind. Every assertion below is
      // scoped to this memory, which is where the property actually lives.
      expect(await world.parseAll()).toBeGreaterThan(0);

      const chunks = await world.sql(
        ingot,
        'SELECT ordinal, section, kind, text FROM ingot_chunks ORDER BY ordinal',
      );

      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks.map((row) => row.section)).toContain(
        'Acme Engineering Handbook > 3 On-call > 3.1 Notice period',
      );

      // The heading is *in the embedded text*, not merely beside it. "An
      // on-call swap requires thirty days" contains no form of the word
      // somebody would search for; "Notice period" does.
      const notice = chunks.find((row) => String(row.section).includes('Notice period'));
      expect(notice?.text).toContain('Notice period');
      expect(notice?.text).toContain('thirty days');
    });

    it('records the document itself, with the title the format already carried', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });
      await world.parseAll();

      const [file] = await world.sql(
        ingot,
        'SELECT filename, media_type, status, chunk_count, title, error FROM ingot_files',
      );

      expect(file).toMatchObject({
        filename: 'handbook.md',
        media_type: 'text/markdown',
        status: FileStatus.Ready,
        title: 'Acme Engineering Handbook',
        error: null,
      });
      expect(Number(file?.chunk_count)).toBeGreaterThan(0);
    });

    /**
     * Being ordinary tables is the whole design, and this is what it buys.
     *
     * None of these was written for documents: the overlay accepted the rows,
     * the embedding queue took the text, and `/query` unions both tiers. A
     * chunk store with its own endpoint would have needed every one of them
     * written a second time.
     */
    it('queues the chunk text through the ordinary embedding path', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });
      await world.parseAll();

      expect(await world.embedAll()).toBeGreaterThan(0);

      const ranked = await world.query(ingot, {
        text: 'how much notice is required',
        table: 'ingot_chunks',
        column: 'text',
        limit: 1,
      });

      expect(ranked.rows).toHaveLength(1);
      // An embedding is how rows are ordered, never a fact anybody stored, so
      // no result carries one — the same rule every other table gets.
      expect(ranked.columns).not.toContain('text_vec');
    });

    it('survives a roll-up into Parquet, like any other table', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });
      await world.parseAll();

      const before = await world.sql(ingot, 'SELECT count(*) AS n FROM ingot_chunks');
      await world.compact(ingot, 'ingot_chunks');
      const after = await world.sql(ingot, 'SELECT count(*) AS n FROM ingot_chunks');

      expect(after).toEqual(before);
    });
  });

  describe('pulling typed rows out of a spreadsheet', () => {
    /**
     * The case that needs no model at all, and the reason `isTabular` exists.
     *
     * A CSV already has field names and records, so the caller's paths resolve
     * against them through the ordinary `/add` mapping. Structured import here
     * costs a parser and nothing else — no provider, no key, no bill.
     */
    it('extracts through the same mapping an /add would use, with no model', async () => {
      const ingot = await world.ingot();
      const accepted = await world.file(
        ingot,
        { filename: 'invoices.csv', mediaType: 'text/csv', content: INVOICES },
        {
          externalId: 'job-77',
          extract: {
            table: 'invoices',
            rows: '$[*]',
            key: ['invoice_no'],
            columns: {
              invoice_no: { from: '$["Invoice #"]', type: ColumnType.Varchar },
              vendor: { from: '$.Vendor', type: ColumnType.Varchar },
              amount: { from: '$.Amount', type: ColumnType.Integer },
            },
          },
        },
      );

      expect(accepted.extractingInto).toBe('invoices');
      await world.parseAll();

      const rows = await world.sql(
        ingot,
        'SELECT invoice_no, vendor, amount FROM invoices ORDER BY amount DESC',
      );

      expect(rows).toEqual([
        { invoice_no: 'CRUX-9903', vendor: 'Crux Analytics', amount: 41200 },
        // The embedded comma survived, which a naive split would have lost —
        // and would have lost silently, by shifting every column after it.
        { invoice_no: 'ACME-4471', vendor: 'Acme Corp, Ltd', amount: 18400 },
        { invoice_no: 'BOLT-0012', vendor: 'Bolt Supplies', amount: 2350 },
      ]);
    });

    /**
     * The claim the whole feature is for, in one statement.
     *
     * A structured filter no vector store can express, over rows pulled out of
     * a document, joined to the chunks of that document and to the document
     * itself. Nothing was written to make this work: it works because all three
     * are tables.
     */
    it('joins extracted facts to chunks and to the document', async () => {
      const ingot = await world.ingot();
      await world.file(
        ingot,
        { filename: 'invoices.csv', mediaType: 'text/csv', content: INVOICES },
        {
          extract: {
            table: 'invoices',
            rows: '$[*]',
            columns: {
              invoice_no: { from: '$["Invoice #"]', type: ColumnType.Varchar },
              amount: { from: '$.Amount', type: ColumnType.Integer },
            },
          },
        },
      );
      await world.parseAll();

      const rows = await world.sql(
        ingot,
        `SELECT f.filename, i.invoice_no, i.amount
         FROM invoices i
         JOIN ingot_chunks c ON c.text LIKE '%' || i.invoice_no || '%'
         JOIN ingot_files f ON f.file_id = c.file_id
         WHERE i.amount > 10000
         ORDER BY i.amount DESC`,
      );

      expect(rows.map((row) => row.invoice_no)).toEqual(['CRUX-9903', 'ACME-4471']);
      expect(rows[0]?.filename).toBe('invoices.csv');
    });

    it('still chunks a spreadsheet nobody wrote an extraction for', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'invoices.csv',
        mediaType: 'text/csv',
        content: INVOICES,
      });
      await world.parseAll();

      const chunks = await world.sql(ingot, 'SELECT kind, text FROM ingot_chunks');

      // Worse than extracting it — a `WHERE amount > 10000` beats any
      // similarity search over the same data — and much better than an upload
      // that produces nothing at all.
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.kind).toBe('table');
      expect(String(chunks[0]?.text)).toContain('Vendor:');
    });
  });

  describe('refusing what it cannot store', () => {
    it('refuses a format this build has no parser for, before storing anything', async () => {
      const ingot = await world.ingot();

      await expect(
        world.file(ingot, {
          filename: 'report.pdf',
          mediaType: 'application/pdf',
          content: '%PDF-1.7\nnot really\n',
        }),
      ).rejects.toThrow(/cannot read application\/pdf/);
    });

    it('refuses bytes that disagree with the type declared for them', async () => {
      const ingot = await world.ingot();

      await expect(
        world.file(ingot, {
          filename: 'a.md',
          mediaType: 'text/markdown',
          content: Buffer.from('%PDF-1.7 pretending'),
        }),
      ).rejects.toThrow(/have to agree/);
    });

    it('refuses an empty document', async () => {
      const ingot = await world.ingot();

      await expect(
        world.file(ingot, { filename: 'a.txt', mediaType: 'text/plain', content: '' }),
      ).rejects.toThrow(/is empty/);
    });

    /**
     * The rule this endpoint is held to: everything refusable is refused while
     * the caller is still holding the response.
     *
     * At `/add` a bad mapping is a 422 to somebody who can fix it. Here the
     * work happens minutes later in a sweeper with nowhere to complain to but
     * a column, so a mapping that cannot be honoured must never be accepted.
     */
    it('refuses a broken extraction at upload rather than in a sweeper', async () => {
      const ingot = await world.ingot();

      await expect(
        world.file(
          ingot,
          { filename: 'invoices.csv', mediaType: 'text/csv', content: INVOICES },
          {
            extract: {
              table: 'invoices',
              columns: { a: { from: '$.Invoice #', type: ColumnType.Varchar } },
            },
          },
        ),
      ).rejects.toThrow(/not a path/);

      // Nothing was stored, so there is nothing to clean up — no table, which
      // is what "before a byte is written" actually looks like from outside.
      await expect(world.sql(ingot, 'SELECT * FROM ingot_files')).rejects.toThrow(
        /no tables yet/,
      );
    });

    /**
     * The improvement on an abandoned receipt, which answers nothing at all.
     *
     * A document that cannot be read still gets a row, so the caller's query
     * says "failed" and why — rather than staying empty for good with the only
     * evidence a gauge an operator has to be watching.
     */
    it('writes a row saying why, when it finally gives up', async () => {
      const ingot = await world.ingot();
      await world.file(
        ingot,
        { filename: 'invoices.csv', mediaType: 'text/csv', content: INVOICES },
        {
          extract: {
            table: 'invoices',
            rows: '$[*]',
            columns: { amount: { from: '$.Vendor', type: ColumnType.Integer } },
          },
        },
      );

      // Four attempts, each charged at claim, then a terminal row.
      await world.parseAll();

      const [file] = await world.sql(ingot, 'SELECT status, error, chunk_count FROM ingot_files');

      expect(file?.status).toBe(FileStatus.Failed);
      expect(String(file?.error)).toMatch(/amount/);
      expect(file?.chunk_count).toBeNull();
    });
  });
});
