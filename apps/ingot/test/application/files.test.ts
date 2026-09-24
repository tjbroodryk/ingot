import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType, FileStatus } from '@ingot/shared/ingot-v1';
import { BackgroundKind } from '../../src/contexts/records/application/background.js';
import { closeDatabase } from '../support/database.js';
import {
  FILE_QUEUE,
  type FileQueue,
} from '../../src/contexts/files/application/ports/file-queue.port.js';
import { compressible, pptx, zipOf } from '../support/office.js';
import { pdf } from '../support/pdf.js';
import { type World, makeWorld } from '../support/world.js';

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

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

/** `/file` end to end: bytes in, rows out, queryable as ordinary tables. */
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

      // Pending: the response is sent before any byte is parsed.
      expect(accepted.status).toBe(FileStatus.Pending);
      expect(accepted.fileId).toStartWith('file_');
      expect(accepted.query).toContain('ingot_files');
      expect(accepted.chunksQuery).toContain('ingot_file_chunks');

      // No table at all yet: a table here is declared by the write that fills it.
      await expect(world.sql(ingot, 'SELECT * FROM ingot_files')).rejects.toThrow(
        /no tables yet/,
      );
    });

    // A `mediaType` override lets the caller name the type when the upload sends
    // `application/octet-stream`; still checked against the bytes.
    it('takes the type from the body when the upload cannot say', async () => {
      const ingot = await world.ingot();
      await world.file(
        ingot,
        { filename: 'a3f9c1', mediaType: 'application/octet-stream', content: INVOICES },
        { mediaType: 'text/csv' },
      );
      await world.parseAll();

      const [file] = await world.sql(
        ingot,
        "SELECT media_type, status, chunk_count FROM ingot_files WHERE filename = 'a3f9c1'",
      );

      expect(file).toMatchObject({ media_type: 'text/csv', status: FileStatus.Ready });
      expect(Number(file?.chunk_count)).toBeGreaterThan(0);
    });

    it('refuses an override the bytes disagree with, like any other claim', async () => {
      const ingot = await world.ingot();

      // The override picks which source is believed, not whether it is checked.
      await expect(
        world.file(
          ingot,
          { filename: 'notes.txt', mediaType: 'text/plain', content: HANDBOOK },
          { mediaType: PPTX },
        ),
      ).rejects.toThrow(/bytes are text/);
    });

    it('wakes the parser rather than leaving it for the next tick', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, { filename: 'a.txt', mediaType: 'text/plain', content: 'hello' });

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
      // Drains everything queued, not only this document; assertions below are
      // scoped to this memory.
      expect(await world.parseAll()).toBeGreaterThan(0);

      const chunks = await world.sql(
        ingot,
        'SELECT ordinal, section, kind, text FROM ingot_file_chunks ORDER BY ordinal',
      );

      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks.map((row) => row.section)).toContain(
        'Acme Engineering Handbook > 3 On-call > 3.1 Notice period',
      );

      // The heading is in the embedded text, not merely beside it.
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
        table: 'ingot_file_chunks',
        column: 'text',
        limit: 1,
      });

      expect(ranked.rows).toHaveLength(1);
      // Same rule as every other table: no result carries the vector column.
      expect(ranked.columns).not.toContain('text_vec');
    });

    // Chunks have keyword search on by default; the index is built lazily when
    // a query mentions `fts_main_…`.
    it('searches chunks by keyword with no configuration', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'runbook.md',
        mediaType: 'text/markdown',
        content:
          '# Runbook\n\nThe collector fails with ECONNREFUSED when the broker is down.\n\n' +
          '## Codes\n\nA 500 is ours. A 404 is the caller’s.\n',
      });
      await world.parseAll();

      const hits = await world.sql(
        ingot,
        `SELECT ordinal FROM ingot_file_chunks
         WHERE fts_main_ingot_file_chunks.match_bm25(_row_id, 'ECONNREFUSED') IS NOT NULL`,
      );

      expect(hits).toHaveLength(1);
    });

    // DuckDB's default `ignore` (`(\.|[^a-z])+`) discards digits, indexing `500`
    // and `404` identically.
    it('keeps digits searchable, which DuckDB’s default would discard', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'codes.md',
        mediaType: 'text/markdown',
        content: '# A\n\nA 500 is ours.\n\n# B\n\nA 404 is the caller’s.\n',
      });
      await world.parseAll();

      const find = (term: string) =>
        world.sql(
          ingot,
          `SELECT ordinal FROM ingot_file_chunks
           WHERE fts_main_ingot_file_chunks.match_bm25(_row_id, '${term}') IS NOT NULL`,
        );

      // Two chunks, one number each; the default tokeniser would match both.
      expect(await find('500')).toHaveLength(1);
      expect(await find('404')).toHaveLength(1);
      expect((await find('500'))[0]?.ordinal).not.toBe((await find('404'))[0]?.ordinal);
    });

    it('leaves the default off for tables that are not guaranteed prose', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'a.md',
        mediaType: 'text/markdown',
        content: '# T\n\nBody.\n',
      });
      await world.parseAll();

      const info = await world.info(ingot);
      const setting = (name: string) =>
        info.tables.find((table) => table.name === name)?.config.fts.enabled;

      expect(setting('ingot_file_chunks')).toBe(true);
      expect(setting('ingot_files')).toBe(false);
    });

    it('survives a roll-up into Parquet, like any other table', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'handbook.md',
        mediaType: 'text/markdown',
        content: HANDBOOK,
      });
      await world.parseAll();

      const before = await world.sql(ingot, 'SELECT count(*) AS n FROM ingot_file_chunks');
      await world.compact(ingot, 'ingot_file_chunks');
      const after = await world.sql(ingot, 'SELECT count(*) AS n FROM ingot_file_chunks');

      expect(after).toEqual(before);
    });
  });

  describe('pulling typed rows out of a spreadsheet', () => {
    // A CSV already has field names and records, so the caller's paths resolve
    // through the ordinary `/add` mapping, with no model.
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
        // The embedded comma survived; a naive split would have shifted every
        // later column.
        { invoice_no: 'ACME-4471', vendor: 'Acme Corp, Ltd', amount: 18400 },
        { invoice_no: 'BOLT-0012', vendor: 'Bolt Supplies', amount: 2350 },
      ]);
    });

    // Extracted rows, chunks, and the document row are all tables, so they join.
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
         JOIN ingot_file_chunks c ON c.text LIKE '%' || i.invoice_no || '%'
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

      const chunks = await world.sql(ingot, 'SELECT kind, text FROM ingot_file_chunks');

      // A spreadsheet with no extraction still chunks, rather than producing nothing.
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.kind).toBe('table');
      expect(String(chunks[0]?.text)).toContain('Vendor:');
    });
  });

  describe('the binary formats', () => {
    it('turns a PDF into one chunk per page, numbered', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'guide.pdf',
        mediaType: 'application/pdf',
        content: pdf([
          ['Deployment Guide', 'Rollout is progressive.'],
          ['Rollback Procedure', 'Any engineer may roll back.'],
        ]),
      });
      await world.parseAll();

      const [file] = await world.sql(
        ingot,
        "SELECT status, pages, chunk_count FROM ingot_files WHERE media_type = 'application/pdf'",
      );
      expect(file).toMatchObject({ status: FileStatus.Ready, pages: 2, chunk_count: 2 });

      const chunks = await world.sql(
        ingot,
        'SELECT ordinal, page, kind, text FROM ingot_file_chunks ORDER BY ordinal',
      );
      expect(chunks.map((row) => row.page)).toEqual([1, 2]);
      expect(String(chunks[1]?.text)).toContain('roll back');
    });

    it('turns a deck into one chunk per slide, with the title as its heading', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'deck.pptx',
        mediaType: PPTX,
        content: pptx([
          { title: 'Q3 revenue', body: ['Up 4% year on year'], notes: 'The price rise landed' },
          { title: 'Next quarter', body: ['Flat, we think'] },
        ]),
      });
      await world.parseAll();

      const chunks = await world.sql(
        ingot,
        'SELECT ordinal, page, kind, section, text FROM ingot_file_chunks ORDER BY ordinal',
      );

      expect(chunks).toHaveLength(2);
      expect(chunks.map((row) => row.kind)).toEqual(['slide', 'slide']);
      expect(chunks[0]?.section).toBe('Q3 revenue');
      // The title is in the embedded text.
      expect(String(chunks[0]?.text)).toContain('Q3 revenue');
      expect(String(chunks[0]?.text)).toContain('The price rise landed');
    });

    it('never merges two slides, however little is on them', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'tiny.pptx',
        mediaType: PPTX,
        content: pptx([{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]),
      });
      await world.parseAll();

      // One chunk per slide, even when all three would fit in one.
      const chunks = await world.sql(ingot, 'SELECT count(*) AS n FROM ingot_file_chunks');
      expect(Number(chunks[0]?.n)).toBe(3);
    });

    it('refuses an archive that claims to expand absurdly, before inflating it', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'bomb.pptx',
        mediaType: PPTX,
        content: compressible(8, 1024 * 1024),
      });
      await world.parseAll();

      const [file] = await world.sql(
        ingot,
        "SELECT status, error FROM ingot_files WHERE filename = 'bomb.pptx'",
      );
      expect(file?.status).toBe(FileStatus.Failed);
      expect(String(file?.error)).toMatch(/expand|refused/i);
    });

    it('refuses a .docx sent as a presentation, since both are zips', async () => {
      const ingot = await world.ingot();
      await world.file(ingot, {
        filename: 'notes.pptx',
        mediaType: PPTX,
        content: zipOf({ 'word/document.xml': '<w:document/>' }),
      });
      await world.parseAll();

      const [file] = await world.sql(
        ingot,
        "SELECT status, error FROM ingot_files WHERE filename = 'notes.pptx'",
      );
      expect(file?.status).toBe(FileStatus.Failed);
      expect(String(file?.error)).toMatch(/no slides/);
    });
  });

  // Destroying a memory must also drop its `file_queue` rows, which nothing
  // else ever visits.
  it('destroys queued uploads along with the memory', async () => {
    // `abandoned(0)` counts every queue row (attempts are never negative). The
    // count is shared across the file, so assert on the delta.
    const queue = world.app.get<FileQueue>(FILE_QUEUE, { strict: false });
    await world.parseAll();
    const before = await queue.abandoned(0);

    const ingot = await world.ingot();
    // One that fails, so it stays in the queue rather than leaving on success.
    await world.file(
      ingot,
      { filename: 'invoices.csv', mediaType: 'text/csv', content: INVOICES },
      {
        extract: {
          table: 'broken',
          rows: '$[*]',
          columns: { n: { from: '$.Vendor', type: ColumnType.Integer } },
        },
      },
    );
    await world.parseAll();
    expect(await queue.abandoned(0)).toBe(before + 1);

    await world.destroy(ingot);

    expect(await queue.abandoned(0)).toBe(before);
  });

  describe('refusing what it cannot store', () => {
    it('refuses a format the registry has no handler for, before storing anything', async () => {
      const ingot = await world.ingot();

      // An unsupported type is refused by the same check as a nonsense one.
      await expect(
        world.file(ingot, {
          filename: 'sheet.xlsx',
          mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          content: zipOf({ 'xl/workbook.xml': '<workbook/>' }),
        }),
      ).rejects.toThrow(/must be one of/);
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

    // A mapping that cannot be honoured is refused at upload, while the caller
    // still holds the response.
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

      // Nothing was stored: no table at all.
      await expect(world.sql(ingot, 'SELECT * FROM ingot_files')).rejects.toThrow(
        /no tables yet/,
      );
    });

    // A document that cannot be read still gets a row, so a query says "failed"
    // and why.
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

      await world.parseAll();

      const [file] = await world.sql(ingot, 'SELECT status, error, chunk_count FROM ingot_files');

      expect(file?.status).toBe(FileStatus.Failed);
      expect(String(file?.error)).toMatch(/amount/);
      expect(file?.chunk_count).toBeNull();
    });
  });
});
