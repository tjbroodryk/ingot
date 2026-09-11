import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/**
 * The column prefix this service keeps for itself.
 *
 * Every row carries `_row_id`, `_ingested_at` and `_batch`, and optionally
 * `_raw`. A caller who could declare a column called `_row_id` could shadow
 * the one tombstones are keyed on, and deleting a row would stop working in a
 * way that looks like a bug in the delete rather than in the mapping.
 */
export const RESERVED_PREFIX = '_';

/**
 * The table prefix this service keeps for itself.
 *
 * `ingot_receipts` and `ingot_embeddings` are ordinary tables in a caller's
 * memory — that is the whole design, because being ordinary is what gets them
 * the overlay, the roll-up into Parquet, tombstones and `/query` without any
 * of it being written twice. Ordinary also means a caller's mapping could
 * write to one, and a memory where that is possible is a memory where a
 * receipt can hand back a summary somebody else wrote.
 *
 * So the namespace is reserved rather than the individual names: reserving
 * only what exists today would mean the next service-owned table is a
 * breaking change for whoever had already used its name.
 */
export const RESERVED_TABLE_PREFIX = 'ingot_';

/**
 * The tables this service writes into a caller's memory.
 *
 * Named here for the error message rather than for the check — the check is
 * the prefix, so this list can grow without anything else moving. `records/`
 * owns what goes in them; this is only what to say when somebody picks a name
 * that collides.
 */
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
 * A table or column name, safe to put in generated SQL.
 *
 * Identifiers are quoted everywhere they are emitted — `at` is a DuckDB
 * keyword and callers pick these names — but quoting alone is not a boundary:
 * a name containing a double quote closes the quoting and starts being SQL.
 * So the character set is restricted here, at the edge, and the quoting
 * downstream is the second layer rather than the only one.
 *
 * Lowercase because DuckDB folds unquoted identifiers to lowercase and we
 * quote ours; without this, `Files` and `files` would be two tables that look
 * like one in every error message.
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
    // Tables only. A *column* called `ingot_id` is an ordinary thing for a
    // caller to want, and reserving the prefix everywhere would take it away
    // to protect a namespace that only exists among tables.
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

  /**
   * For the tables this service writes on a caller's behalf — `ingot_receipts`.
   *
   * Deliberately not reachable from `/add`: `RowMapping` parses its table
   * name with `table()`, which refuses the prefix. That asymmetry is the whole
   * protection, so this is the one place allowed to bypass it and it is called
   * from exactly one.
   */
  static systemTable(raw: string): SqlName {
    return SqlName.parse(raw, 'table', true);
  }

  toString(): string {
    return this.value;
  }
}
