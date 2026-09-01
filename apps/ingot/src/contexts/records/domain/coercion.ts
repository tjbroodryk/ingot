import { ColumnType } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../../../shared/domain/index.js';

/**
 * What a coerced value looks like on its way to the overlay.
 *
 * Timestamps and dates become ISO strings rather than `Date`, because the
 * overlay stores a JSON document and this is the form that survives the round
 * trip into DuckDB without a second parse deciding what it meant.
 */
export type Coerced = string | number | boolean | null;

/**
 * Turns a JSON value into the declared column type, or refuses.
 *
 * Coercion happens at `/add`, which is the whole point: the caller who wrote
 * the mapping is the person who can fix it, and they are still on the phone.
 * Deferring this to query time means the error surfaces to somebody else,
 * months later, as a column that is mysteriously empty.
 *
 * Absent is not an error. A tool result that omitted a field reads as null —
 * that is a fact about the result, not a mistake in the mapping.
 */
export function coerce(value: unknown, type: ColumnType, column: string): Coerced {
  if (value === undefined || value === null) return null;

  switch (type) {
    case ColumnType.Varchar:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      // Deliberately not JSON.stringify: silently stringifying an object gives
      // a column full of `[object Object]`-shaped surprises that only show up
      // in a query. Declare it JSON instead.
      throw refuse(column, value, 'VARCHAR', 'declare this column JSON to keep the structure');

    case ColumnType.Integer:
    case ColumnType.BigInt: {
      const parsed = asNumber(value, column, type);
      if (!Number.isInteger(parsed)) {
        throw refuse(column, value, type, 'it has a fractional part — declare it DOUBLE');
      }
      if (type === ColumnType.Integer && (parsed > 2_147_483_647 || parsed < -2_147_483_648)) {
        throw refuse(column, value, type, 'it does not fit in 32 bits — declare it BIGINT');
      }
      return parsed;
    }

    case ColumnType.Double:
      return asNumber(value, column, type);

    case ColumnType.Boolean: {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw refuse(column, value, 'BOOLEAN', 'expected true, false, "true", "false", 1 or 0');
    }

    case ColumnType.Timestamp:
    case ColumnType.Date: {
      const at = asDate(value);
      if (!at)
        throw refuse(column, value, type, 'expected an ISO 8601 string or epoch milliseconds');
      const iso = at.toISOString();
      return type === ColumnType.Date ? iso.slice(0, 10) : iso;
    }

    case ColumnType.Json:
      // The one type that takes anything, because that is what it is for.
      return JSON.stringify(value);
  }
}

function asNumber(value: unknown, column: string, type: ColumnType): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw refuse(column, value, type, 'expected a number');
}

function asDate(value: unknown): Date | null {
  if (typeof value === 'number') {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function refuse(column: string, value: unknown, type: string, why: string): InvariantViolation {
  return new InvariantViolation(
    `column "${column}" is declared ${type}, but the mapping produced ${preview(value)} — ${why}`,
  );
}

/**
 * A short, safe rendering of the offending value.
 *
 * Truncated because the value came from a tool result and could be a whole
 * file; an error message is not a place to echo one back.
 */
function preview(value: unknown): string {
  const rendered = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
  const text = rendered ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
