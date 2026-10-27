import { ColumnType, type ExtractMapping, type FileExtraction } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../../../shared/domain/index.js';

const INTEGER = /^-?(0|[1-9]\d*)$/;
const DECIMAL = /^-?(0|[1-9]\d*)?(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * An extraction with no `columns`, completed from a tabular document's header.
 *
 * Each header becomes a column named for it and typed by what every row holds
 * there. Blank cells are nulls, since a CSV has no other way to say so and
 * `coerce` refuses `""` for anything but VARCHAR.
 */
export function inferExtraction(
  extraction: FileExtraction,
  rows: readonly Record<string, unknown>[],
): { extraction: FileExtraction; rows: Record<string, unknown>[] } {
  const first = rows[0];
  if (!first) {
    throw new InvariantViolation(
      `"extract.columns" was left out for "${extraction.table}", and the file has no data rows ` +
        'to infer them from.',
    );
  }

  const cleaned = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => [name, value === '' ? null : value]),
    ),
  );

  const taken = new Set<string>();
  const columns: Record<string, ExtractMapping> = {};
  for (const header of Object.keys(first)) {
    const name = unique(columnName(header), taken);
    columns[name] = {
      from: `$["${header.replace(/["\\]/g, '\\$&')}"]`,
      type: typeOf(cleaned.map((row) => row[header])),
    };
  }

  return { extraction: { ...extraction, rows: extraction.rows ?? '$[*]', columns }, rows: cleaned };
}

/** The narrowest type every value fits; a leading zero keeps a code a string. */
function typeOf(values: readonly unknown[]): ColumnType {
  const present = values.filter((value): value is string => typeof value === 'string');
  if (present.length === 0) {
    return ColumnType.Varchar;
  }
  if (present.every((value) => INTEGER.test(value))) {
    const numbers = present.map(Number);
    if (numbers.every((n) => n <= 2_147_483_647 && n >= -2_147_483_648)) {
      return ColumnType.Integer;
    }
    // Past 2^53 a Number is no longer the value that was written.
    return numbers.every(Number.isSafeInteger) ? ColumnType.BigInt : ColumnType.Varchar;
  }
  if (present.every((value) => /\d/.test(value) && DECIMAL.test(value))) {
    return ColumnType.Double;
  }
  if (present.every((value) => value === 'true' || value === 'false')) {
    return ColumnType.Boolean;
  }
  return ColumnType.Varchar;
}

/** `Invoice #` → `invoice`, `2024 Total` → `c_2024_total`: what `SqlName` accepts. */
function columnName(header: string): string {
  const name = header
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    // Room for a `c_` prefix and a `_NN` suffix inside SqlName's 63.
    .slice(0, 56);
  if (name.length === 0) {
    return 'column';
  }
  return /^[0-9]/.test(name) ? `c_${name}` : name;
}

function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${name}_${n}`;
  }
  taken.add(candidate);
  return candidate;
}
