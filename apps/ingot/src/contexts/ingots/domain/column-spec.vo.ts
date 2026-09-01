import { ColumnType } from '@ingot/shared/ingot-v1';
import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';
import { SqlName } from './sql-name.vo.js';

/**
 * One column of one table, as the manifest holds it.
 *
 * `required` is false for anything added after the table already had rows: the
 * older Parquet files have no such column, so `union_by_name` reads it as null
 * and the column can never be non-nullable again. Recording that is what lets
 * `/info` tell a caller which columns they can rely on.
 */
export class ColumnSpec extends ValueObject {
  readonly name: SqlName;
  readonly type: ColumnType;
  readonly embedded: boolean;
  readonly required: boolean;

  private constructor(name: SqlName, type: ColumnType, embedded: boolean, required: boolean) {
    super();
    this.name = name;
    this.type = type;
    this.embedded = embedded;
    this.required = required;
    this.seal();
  }

  static of(input: {
    name: string;
    type: string;
    embedded?: boolean;
    required?: boolean;
    reserved?: boolean;
  }): ColumnSpec {
    const name = input.reserved ? SqlName.reserved(input.name) : SqlName.column(input.name);
    // Parsed at the edge, never cast: the type arrives as a string off the
    // wire and is not a ColumnType until something has checked.
    const type = Guard.oneOf(
      input.type.toUpperCase(),
      Object.values(ColumnType),
      `column.${name.value}.type`,
    );
    const embedded = input.embedded ?? false;

    if (embedded && type !== ColumnType.Varchar) {
      throw new InvariantViolation(
        `column "${name.value}" is declared ${type} and cannot be embedded — ` +
          'only VARCHAR columns carry text to embed',
      );
    }

    return new ColumnSpec(name, type, embedded, input.required ?? true);
  }

  /** The same column, no longer guaranteed present on every row. */
  asOptional(): ColumnSpec {
    return this.required ? new ColumnSpec(this.name, this.type, this.embedded, false) : this;
  }
}
