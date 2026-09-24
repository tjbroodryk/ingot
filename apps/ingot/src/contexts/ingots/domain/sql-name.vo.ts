import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/** Prefix reserved for service-managed columns. */
export const RESERVED_PREFIX = '_';

/** Prefix reserved for service-managed tables. */
export const RESERVED_TABLE_PREFIX = 'ingot_';

/** Reserved table names, used to name the collision in the error message. */
export const RESERVED_TABLES: readonly string[] = [
  'ingot_receipts',
  'ingot_embeddings',
  'ingot_files',
  'ingot_file_chunks',
];

export const ROW_ID = '_row_id';
export const INGESTED_AT = '_ingested_at';
export const BATCH = '_batch';
export const RAW = '_raw';

/** Columns this service adds to every row, in the order it adds them. */
export const RESERVED_COLUMNS: readonly string[] = [ROW_ID, INGESTED_AT, BATCH, RAW];

/**
 * A table or column name validated for use in generated SQL.
 *
 * Restricts the character set and lowercases the value (DuckDB folds unquoted
 * identifiers to lowercase).
 */
export class SqlName extends ValueObject {
  readonly value: string;

  private constructor(value: string) {
    super();
    this.value = value;
  }

  private static parse(raw: string, field: string, allowReserved: boolean): SqlName {
    const value = Guard.notBlank(raw, field).toLowerCase();
    Guard.inRange(value.length, 1, 63, `${field} length`);

    if (!allowReserved && value.startsWith(RESERVED_PREFIX)) {
      throw new InvariantViolation(
        `${field} "${value}" starts with "_", which this service keeps for ` +
          `${RESERVED_COLUMNS.join(', ')}`,
      );
    }
    // Tables only; the prefix is not reserved for column names.
    if (!allowReserved && field === 'table' && value.startsWith(RESERVED_TABLE_PREFIX)) {
      throw new InvariantViolation(
        `${field} "${value}" starts with "${RESERVED_TABLE_PREFIX}", which this service keeps ` +
          `for the tables it writes on your behalf — ${RESERVED_TABLES.join(', ')}. ` +
          'Those are ordinary tables you can query and delete from; you just cannot write to ' +
          'them, because a receipt has to be the one this service wrote.',
      );
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
      throw new InvariantViolation(
        `${field} "${value}" must be a letter or underscore followed by letters, digits or underscores`,
      );
    }

    const name = new SqlName(value);
    name.seal();
    return name;
  }

  static table(raw: string): SqlName {
    return SqlName.parse(raw, 'table', false);
  }

  static column(raw: string): SqlName {
    return SqlName.parse(raw, 'column', false);
  }

  /** For the columns this service adds itself, which are the reserved ones. */
  static reserved(raw: string): SqlName {
    return SqlName.parse(raw, 'column', true);
  }

  /** For service-owned tables (e.g. `ingot_receipts`); bypasses the prefix check. */
  static systemTable(raw: string): SqlName {
    return SqlName.parse(raw, 'table', true);
  }

  toString(): string {
    return this.value;
  }
}
