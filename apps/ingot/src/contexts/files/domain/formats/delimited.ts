import { InvariantViolation } from '../../../../shared/domain/index.js';

/** How many records one delimited file may hold. */
export const MAX_ROWS = 10_000;

/** Above this many columns, the header row is not a header row. */
const MAX_FIELDS = 512;

/**
 * A CSV or TSV, parsed to objects keyed by the header row.
 *
 * Hand-written to be correct about quotes (a field with a comma is common). The
 * delimiter is sniffed from the header line.
 */
export function parseDelimited(text: string): Record<string, unknown>[] {
  const delimiter = delimiterOf(text);
  const records = records_(text, delimiter);

  const header = records.shift();
  if (!header || header.length === 0) {
    throw new InvariantViolation('The file has no header row, so its columns have no names');
  }
  if (header.length > MAX_FIELDS) {
    throw new InvariantViolation(
      `The header row has ${header.length} fields, and at most ${MAX_FIELDS} is a table. ` +
        'This is usually a file that was not delimited the way it looked.',
    );
  }
  if (records.length > MAX_ROWS) {
    throw new InvariantViolation(
      `The file holds ${records.length} rows, and this service reads at most ${MAX_ROWS} from ` +
        'one document. Split it and upload the parts.',
    );
  }

  // Blank names get a positional one rather than being dropped.
  const names = header.map((name, at) => (name.trim().length > 0 ? name.trim() : `column_${at + 1}`));

  return records.map((record) => {
    const row: Record<string, unknown> = {};
    names.forEach((name, at) => {
      // A short row is padded with null rather than refused.
      row[name] = record[at] ?? null;
    });
    return row;
  });
}

/** Whichever candidate appears most in the header line. */
function delimiterOf(text: string): string {
  const header = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [',', '\t', ';', '|'].map(
    (candidate) => [candidate, header.split(candidate).length - 1] as const,
  );

  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/** The file as arrays of fields, honouring RFC 4180 quoting. */
function records_(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    // A trailing newline produces one empty record, which is not a row.
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };

  for (let at = 0; at < text.length; at++) {
    const character = text[at] as string;

    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[at + 1] === '"') {
        // `""` inside a quoted field is one literal quote.
        field += '"';
        at++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) endField();
    else if (character === '\n') endRecord();
    else if (character !== '\r') field += character;
  }

  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

/**
 * Rows as `name: value` text, for the chunk a spreadsheet gets when nobody
 * extracted it — the header words are what make it embeddable.
 */
export function renderRows(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) =>
      Object.entries(row)
        .filter(([, value]) => value !== null && value !== '')
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join('\n'),
    )
    .join('\n\n');
}
