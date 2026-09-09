import { InvariantViolation } from '../../../../shared/domain/index.js';

/**
 * How many records one delimited file may hold.
 *
 * The same bound `MAX_ROWS_PER_ADD` puts on a fan-out, and for the same reason:
 * a mapping that produces a hundred thousand rows from one call is a caller who
 * should be sending batches. Here it also bounds the chunker, since a tabular
 * document produces a block per row.
 */
export const MAX_ROWS = 10_000;

/** Above this many columns, the header row is not a header row. */
const MAX_FIELDS = 512;

/**
 * A CSV or TSV, parsed to objects keyed by the header row.
 *
 * Written out rather than taken from a library, because the whole of RFC 4180
 * is quoting, escaped quotes and embedded newlines — about thirty lines — and
 * the dependency would be carrying a file-format guesser, an encoding detector
 * and a streaming API for none of which there is a use here. What matters is
 * that it is *correct about quotes*: a field containing a comma is the single
 * most common thing in a real export, and a naive `split(',')` silently shifts
 * every column after it.
 *
 * The delimiter is sniffed from the header line rather than declared, because a
 * `.tsv` and a `.csv` reach this by the same media type and asking a caller
 * which one they uploaded is asking them something the file already says.
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

  // Blank names are given a positional one rather than dropped. A trailing
  // delimiter produces an unnamed final column in a great many real exports,
  // and silently discarding it loses whatever was in it.
  const names = header.map((name, at) => (name.trim().length > 0 ? name.trim() : `column_${at + 1}`));

  return records.map((record) => {
    const row: Record<string, unknown> = {};
    names.forEach((name, at) => {
      // A short row is padded rather than refused: a ragged export is ordinary,
      // and a null in a column beats losing every row after the first bad one.
      row[name] = record[at] ?? null;
    });
    return row;
  });
}

/**
 * Whichever of the candidates appears most in the first line.
 *
 * The header is what is counted rather than the whole file, because it is the
 * one line guaranteed to have every delimiter and no free text — a body row
 * full of prose containing semicolons would otherwise outvote the real one.
 */
function delimiterOf(text: string): string {
  const header = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [',', '\t', ';', '|'].map(
    (candidate) => [candidate, header.split(candidate).length - 1] as const,
  );

  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/**
 * The file as arrays of fields, honouring RFC 4180 quoting.
 *
 * A character loop rather than a regex, because the thing that makes this
 * correct — a newline inside a quoted field is data, not a record boundary —
 * is exactly the thing a line-oriented reader gets wrong, and it gets it wrong
 * silently.
 */
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
 * Rows as text, for the chunk a spreadsheet gets when nobody extracted it.
 *
 * `name: value` per line rather than the original comma-separated form,
 * because what is being produced here is something to *embed*. A bare row of
 * values has no words in it — `ACME-4471,2026-03-01,18400` ranks against
 * nothing anybody would type — and repeating the header on every line is what
 * puts "invoice", "vendor" and "total" into the vector.
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
