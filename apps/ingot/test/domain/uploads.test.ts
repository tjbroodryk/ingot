import { describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { FileMapping } from '../../src/contexts/files/domain/file-mapping.vo.js';
import { ByteShape } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import { isTabular, mediaTypeOf, shapeOf } from '../../src/contexts/files/domain/formats/detect.js';
import { parseDelimited, renderRows } from '../../src/contexts/files/domain/formats/delimited.js';

/**
 * `/file` is the one endpoint that takes opaque bytes from anyone holding a
 * key and hands them to a decoder, so it is a boundary and is tested as one.
 */
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

  /**
   * The check that is the point of having two sources.
   *
   * A declared type alone is a caller choosing which decoder runs on their
   * bytes. Getting it wrong means handing a decoder something it was not
   * written for, which is the failure mode every parser CVE starts from.
   */
  it('refuses bytes that disagree with the type declared for them', () => {
    expect(() =>
      mediaTypeOf({ declared: 'application/pdf', filename: 'a.pdf', head: head('not a pdf') }),
    ).toThrow(/bytes are text/);

    expect(() =>
      mediaTypeOf({ declared: 'text/plain', filename: 'a.txt', head: head('%PDF-1.7') }),
    ).toThrow(/bytes are a PDF/);
  });

  /**
   * The other half: sniffing alone cannot answer this, and must not pretend to.
   *
   * `PK\x03\x04` is a .docx, a .pptx, a .xlsx and a jar. Choosing one from the
   * bytes would be choosing a parser on the caller's behalf.
   */
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
      // The case it exists for: a client that sends octet-stream for everything
      // and a document with no useful name — a stream, a generated id, a proxy
      // that flattened the type on the way through.
      expect(
        mediaTypeOf({
          override: 'text/csv',
          declared: 'application/octet-stream',
          filename: 'a3f9c1',
          head: head('a,b\n1,2'),
        }),
      ).toBe(MediaType.Csv);

      // And the case where a name lies: a `.txt` export that is really CSV
      // parses as prose until somebody says otherwise.
      expect(
        mediaTypeOf({
          override: 'text/csv',
          declared: 'text/plain',
          filename: 'export.txt',
          head: head('a,b\n1,2'),
        }),
      ).toBe(MediaType.Csv);
    });

    /**
     * The property that makes the override safe to offer at all.
     *
     * It changes which of the three sources is believed and nothing about the
     * check. A caller who could name a decoder for arbitrary bytes would be
     * exactly what the agreement rule exists to prevent — so an override that
     * disagrees with the content is refused like any other claim.
     */
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
      // A caller who set all three has no way to debug a refusal otherwise.
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
    // There is no text file that legitimately contains one, and the absence of
    // a signature is the only evidence text ever offers.
    expect(() => shapeOf(Buffer.from([0x61, 0x00, 0x62]))).toThrow(/binary/);
  });

  it('knows which formats already have rows of their own', () => {
    // Read off the handler rather than a second table, which is what stops
    // "is this tabular" and "how is this parsed" ever disagreeing.
    expect(isTabular(MediaType.Csv)).toBe(true);
    expect(isTabular(MediaType.Pdf)).toBe(false);
    expect(isTabular(MediaType.Markdown)).toBe(false);
    expect(isTabular(MediaType.Pptx)).toBe(false);
  });
});

/**
 * Reading a delimited file, where the only thing that really matters is quoting.
 *
 * A field containing the delimiter is the single most common thing in a real
 * export, and a naive `split(',')` silently shifts every column after it —
 * producing a table that is wrong rather than one that fails.
 */
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

  /**
   * The rendered form is for embedding, which is why it is not the original.
   *
   * A bare row of values has no words in it — `ACME-4471,2026-03-01,18400`
   * ranks against nothing anybody would type. Repeating the header on each line
   * is what puts "invoice", "vendor" and "total" into the vector.
   */
  it('renders a row with its field names, for the chunk it becomes', () => {
    const text = renderRows([{ vendor: 'Acme', total: 18400, note: '' }]);

    expect(text).toContain('vendor: Acme');
    expect(text).toContain('total: 18400');
    // An empty field contributes nothing but noise to an embedding.
    expect(text).not.toContain('note:');
  });
});

/**
 * The extraction mapping, checked at upload while the caller can still fix it.
 *
 * That timing is the whole design here. At `/add` a bad mapping is a 422 to
 * somebody holding the response; at `/file` the work happens in a sweeper
 * minutes later with nowhere to complain to but a column, so anything
 * refusable has to be refused before a byte is stored.
 */
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
    // A described column becomes `$.<name>`, because the schema handed to a
    // model is a flat object keyed by column name. That is the join between
    // the two halves, and it is one line rather than a format.
    expect(mapping.asColumnMappings().notice_days?.from).toBe('$.notice_days');
  });

  /**
   * Mixing the two is refused rather than resolved.
   *
   * A mapping half paths and half descriptions is one whose author has not
   * decided what they uploaded, and guessing produces a table filled partly
   * from a model and partly from a header row with nothing recording which.
   */
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

  /**
   * The bug this suite exists to have caught: a path checked only in the worker.
   *
   * `$.Invoice #` is what somebody writes the first time, because that is what
   * the header says. Discovering it four attempts deep in a sweeper — with the
   * caller gone and the only evidence a `status` column — is the failure the
   * whole "refuse it at upload" rule is for.
   */
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

  /**
   * A model asked for a shape nobody declared invents one, and invents a
   * different one next time — so every query over the column would depend on
   * what it felt like returning that day.
   */
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
    // that asymmetry is what keeps `ingot_chunks` ours.
    expect(() =>
      FileMapping.parse(
        { table: 'ingot_chunks', columns: { a: { from: '$.a', type: ColumnType.Varchar } } },
        tabular,
      ),
    ).toThrow(/keeps/);
  });
});
