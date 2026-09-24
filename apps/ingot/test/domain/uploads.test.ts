import { describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { FileMapping } from '../../src/contexts/files/domain/file-mapping.vo.js';
import { ByteShape } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { isTabular, mediaTypeOf, shapeOf } from '../../src/contexts/files/domain/formats/detect.js';
import { parseDelimited, renderRows } from '../../src/contexts/files/domain/formats/delimited.js';

/** `/file` takes opaque bytes and hands them to a decoder — a boundary, tested as one. */
describe('deciding what an upload is', () => {
  const head = (text: string): Buffer => Buffer.from(text);

  it('believes a declared type the bytes agree with', () => {
    expect(
      mediaTypeOf({ declared: 'text/markdown', filename: 'a.md', head: head('# Title') }),
    ).toBe(MediaType.Markdown);
  });

  it('reads a charset off the declared type rather than choking on it', () => {
    expect(
      mediaTypeOf({ declared: 'text/csv; charset=utf-8', filename: 'a.csv', head: head('a,b') }),
    ).toBe(MediaType.Csv);
  });

  it('refuses bytes that disagree with the type declared for them', () => {
    expect(() =>
      mediaTypeOf({ declared: 'application/pdf', filename: 'a.pdf', head: head('not a pdf') }),
    ).toThrow(/bytes are text/);

    expect(() =>
      mediaTypeOf({ declared: 'text/plain', filename: 'a.txt', head: head('%PDF-1.7') }),
    ).toThrow(/bytes are a PDF/);
  });

  it('cannot tell the OOXML formats apart from bytes, and does not try', () => {
    const zip = head('PK\x03\x04rest of the archive');

    // The shape is as far as the bytes go: every OOXML format, and a jar, look
    // exactly like this. Which one it is comes from the declared type.
    expect(shapeOf(zip)).toBe(ByteShape.Zip);
    expect(mediaTypeOf({ declared: MediaType.Pptx, filename: 'a.pptx', head: zip })).toBe(
      MediaType.Pptx,
    );

    // A zip declared as something this build has no handler for is refused by
    // name, since `MediaType` is now exactly what `FORMATS` covers.
    expect(() =>
      mediaTypeOf({
        declared: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'a.docx',
        head: zip,
      }),
    ).toThrow(/must be one of/);
  });

  describe('the caller’s own mediaType', () => {
    it('is believed over the header and the filename', () => {
      // A client that sends octet-stream for everything, with no useful filename.
      expect(
        mediaTypeOf({
          override: 'text/csv',
          declared: 'application/octet-stream',
          filename: 'a3f9c1',
          head: head('a,b\n1,2'),
        }),
      ).toBe(MediaType.Csv);

      // A `.txt` export that is really CSV: the name lies.
      expect(
        mediaTypeOf({
          override: 'text/csv',
          declared: 'text/plain',
          filename: 'export.txt',
          head: head('a,b\n1,2'),
        }),
      ).toBe(MediaType.Csv);
    });

    // The override changes which of the three sources is believed, not the
    // agreement check, so one disagreeing with the bytes is still refused.
    it('cannot talk this service into pointing a decoder at the wrong bytes', () => {
      expect(() =>
        mediaTypeOf({
          override: MediaType.Pptx,
          declared: 'text/plain',
          filename: 'notes.txt',
          head: head('%PDF-1.7 actually a pdf'),
        }),
      ).toThrow(/bytes are a PDF/);

      expect(() =>
        mediaTypeOf({
          override: 'text/markdown',
          declared: 'application/pdf',
          filename: 'a.pdf',
          head: head('%PDF-1.7'),
        }),
      ).toThrow(/bytes are a PDF/);
    });

    it('is held to the same closed set the header is', () => {
      // A stronger signal about *which* format, never permission to name one
      // this service has no handler for.
      expect(() =>
        mediaTypeOf({
          override: 'application/x-msdownload',
          declared: 'text/plain',
          filename: 'a.txt',
          head: head('hello'),
        }),
      ).toThrow(/mediaType must be one of/);
    });

    it('says which of the three sources it believed, when they disagree', () => {
      expect(() =>
        mediaTypeOf({
          override: 'text/csv',
          declared: 'application/pdf',
          filename: 'a.pdf',
          head: head('%PDF-1.7'),
        }),
      ).toThrow(/according to the "mediaType" you sent/);

      expect(() =>
        mediaTypeOf({ declared: 'application/pdf', filename: 'a.pdf', head: head('plain text') }),
      ).toThrow(/according to the upload’s Content-Type/);

      expect(() =>
        mediaTypeOf({
          declared: 'application/octet-stream',
          filename: 'a.pdf',
          head: head('plain text'),
        }),
      ).toThrow(/according to the filename extension/);
    });

    it('ignores a blank one rather than treating it as a claim', () => {
      for (const override of ['', '   ', undefined]) {
        expect(
          mediaTypeOf({ override, declared: 'text/markdown', filename: 'a.md', head: head('# x') }),
        ).toBe(MediaType.Markdown);
      }
    });

    it('reads parameters off it, as it does off the header', () => {
      expect(
        mediaTypeOf({
          override: 'text/csv; charset=utf-8',
          declared: 'application/octet-stream',
          filename: 'x',
          head: head('a,b'),
        }),
      ).toBe(MediaType.Csv);
    });
  });

  it('falls back to the extension when a client will not commit to a type', () => {
    for (const declared of ['application/octet-stream', '', undefined]) {
      expect(mediaTypeOf({ declared, filename: 'notes.md', head: head('# x') })).toBe(
        MediaType.Markdown,
      );
    }
  });

  it('refuses an octet-stream whose extension says nothing either', () => {
    expect(() =>
      mediaTypeOf({ declared: 'application/octet-stream', filename: 'a.xyz', head: head('hi') }),
    ).toThrow(/without a media type/);
  });

  it('refuses a media type this service has no name for', () => {
    expect(() =>
      mediaTypeOf({ declared: 'application/x-msdownload', filename: 'a.exe', head: head('MZ') }),
    ).toThrow(/must be one of/);
  });

  it('treats a NUL byte as proof it is not text', () => {
    // No text file legitimately contains a NUL byte.
    expect(() => shapeOf(Buffer.from([0x61, 0x00, 0x62]))).toThrow(/binary/);
  });

  it('knows which formats already have rows of their own', () => {
    // Read off the handler, not a second table, so the two can't disagree.
    expect(isTabular(MediaType.Csv)).toBe(true);
    expect(isTabular(MediaType.Pdf)).toBe(false);
    expect(isTabular(MediaType.Markdown)).toBe(false);
    expect(isTabular(MediaType.Pptx)).toBe(false);
  });
});

/** Reading a delimited file, where the thing that matters is quoting. */
describe('reading a delimited file', () => {
  it('keeps a delimiter that is inside quotes', () => {
    const rows = parseDelimited('name,note\n"Acme Corp, Ltd",fine\n');

    expect(rows).toEqual([{ name: 'Acme Corp, Ltd', note: 'fine' }]);
  });

  it('reads a doubled quote as one literal quote', () => {
    const rows = parseDelimited('name\n"She said ""hello"""\n');

    expect(rows[0]?.name).toBe('She said "hello"');
  });

  it('keeps a newline that is inside quotes', () => {
    const rows = parseDelimited('name,note\n"multi\nline",x\n');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe('x');
  });

  it('sniffs the delimiter from the header, which is the one line with no prose', () => {
    expect(parseDelimited('a\tb\n1\t2\n')).toEqual([{ a: '1', b: '2' }]);
    expect(parseDelimited('a;b\n1;2\n')).toEqual([{ a: '1', b: '2' }]);
  });

  it('pads a ragged row rather than losing every row after it', () => {
    const rows = parseDelimited('a,b,c\n1,2\n');

    expect(rows[0]).toEqual({ a: '1', b: '2', c: null });
  });

  it('names an unnamed column rather than discarding what is in it', () => {
    const rows = parseDelimited('a,\n1,2\n');

    expect(rows[0]).toEqual({ a: '1', column_2: '2' });
  });

  it('refuses a file with no header row, since its columns have no names', () => {
    expect(() => parseDelimited('')).toThrow(/no header row/);
  });

  // Repeats the field name on each value so the embedding has words in it, not
  // bare values like `ACME-4471,2026-03-01,18400`.
  it('renders a row with its field names, for the chunk it becomes', () => {
    const text = renderRows([{ vendor: 'Acme', total: 18400, note: '' }]);

    expect(text).toContain('vendor: Acme');
    expect(text).toContain('total: 18400');
    // An empty field contributes nothing but noise to an embedding.
    expect(text).not.toContain('note:');
  });
});

/** The extraction mapping, checked at upload while the caller can still fix it. */
describe('an extraction mapping', () => {
  const prose = { tabular: false };
  const tabular = { tabular: true };

  it('accepts paths against a document that has field names', () => {
    const mapping = FileMapping.parse(
      {
        table: 'invoices',
        rows: '$[*]',
        key: ['invoice_no'],
        columns: {
          invoice_no: { from: '$["Invoice #"]', type: ColumnType.Varchar },
          amount: { from: '$.Amount', type: ColumnType.Integer },
        },
      },
      tabular,
    );

    expect(mapping.table.value).toBe('invoices');
    expect(mapping.fromPaths).toBe(true);
  });

  it('accepts descriptions against prose', () => {
    const mapping = FileMapping.parse(
      {
        table: 'contracts',
        columns: {
          notice_days: { describe: 'notice to terminate, in days', type: ColumnType.Integer },
        },
      },
      prose,
    );

    expect(mapping.fromPaths).toBe(false);
    // A described column becomes `$.<name>`: the schema handed to a model is a
    // flat object keyed by column name.
    expect(mapping.asColumnMappings().notice_days?.from).toBe('$.notice_days');
  });

  // Paths and descriptions can't be mixed: half-model, half-header, with
  // nothing recording which.
  it('refuses a description on a document that has real field names', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', columns: { a: { describe: 'the thing', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/no model is needed at all/);
  });

  it('refuses a path into prose, which has nothing to path into', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', columns: { a: { from: '$.a', type: ColumnType.Varchar } } },
        prose,
      ),
    ).toThrow(/nothing to path into/);
  });

  it('refuses a column filled two ways, or none', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', columns: { a: { from: '$.a', value: 'x', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/exactly one of/);

    expect(() =>
      FileMapping.parse({ table: 't', columns: { a: { type: ColumnType.Varchar } } }, tabular),
    ).toThrow(/exactly one of/);
  });

  it('parses every path now, so a typo is a 422 rather than a failed row later', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', columns: { a: { from: '$.Invoice #', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/not a path/);

    expect(() =>
      FileMapping.parse(
        { table: 't', rows: 'files', columns: { a: { from: '$.a', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/must start with/);
  });

  it('refuses a key naming a column the extraction does not fill', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', key: ['missing'], columns: { a: { from: '$.a', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/does not fill/);
  });

  it('refuses a fan-out from prose, which has no structure to fan out', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', rows: '$.items[*]', columns: { a: { describe: 'x', type: ColumnType.Varchar } } },
        prose,
      ),
    ).toThrow(/no structure to fan out/);
  });

  // A model asked for an undeclared shape invents a different one each time.
  it('refuses a JSON column filled by a model', () => {
    expect(() =>
      FileMapping.parse(
        { table: 't', columns: { a: { describe: 'the details', type: ColumnType.Json } } },
        prose,
      ),
    ).toThrow(/invents one/);
  });

  it('refuses an extraction that would write into a table this service owns', () => {
    // The same protection `/add` gets: `SqlName.table` refuses the prefix, and
    // that asymmetry is what keeps `ingot_file_chunks` ours.
    expect(() =>
      FileMapping.parse(
        { table: 'ingot_file_chunks', columns: { a: { from: '$.a', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/keeps/);
  });
});
