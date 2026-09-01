import type { AddBody, ColumnMapping } from '@ingot/shared/ingot-v1';
import { Guard, InvariantViolation } from '../../../shared/domain/index.js';
import { BATCH, ColumnSpec, INGESTED_AT, RAW, ROW_ID } from '../../ingots/domain/index.js';
import { type Coerced, coerce } from './coercion.js';
import { type ParsedPath, parsePath, readPath, readRows } from './json-path.js';

/** A row on its way to the overlay: column name to already-coerced value. */
export type MappedRow = Readonly<Record<string, Coerced>>;

export interface MappingResult {
  readonly rows: readonly MappedRow[];
  /** What the mapping says the table's columns are, for `accommodate`. */
  readonly columns: readonly ColumnSpec[];
}

interface Plan {
  readonly spec: ColumnSpec;
  readonly path: ParsedPath | null;
  readonly constant: Coerced;
}

/** How many rows one `/add` may fan out into. */
export const MAX_ROWS_PER_ADD = 10_000;

/**
 * The projection from an arbitrary tool result to typed columns.
 *
 * Parsed once and applied to every fanned-out row, so a mapping with a bad
 * path fails before anything is written rather than halfway through.
 */
export class RowMapping {
  private constructor(
    readonly table: string,
    readonly raw: boolean,
    /** The columns that identify a row, as the caller named them. */
    readonly key: readonly string[],
    private readonly rowsPath: ParsedPath | null,
    private readonly plans: readonly Plan[],
  ) {}

  static parse(body: AddBody): RowMapping {
    const entries = Object.entries(body.columns ?? {});
    Guard.notEmpty(entries, 'columns');

    const plans = entries.map(([name, mapping]) => planFor(name, mapping));
    const rowsPath = body.rows ? parsePath(body.rows, 'rows', true) : null;

    // Only lowercased here; whether these are real columns is the table's
    // question, since it is the table the key belongs to.
    const key = (body.key ?? []).map((column) => String(column).toLowerCase());

    return new RowMapping(body.table, body.raw ?? false, key, rowsPath, plans);
  }

  get columns(): readonly ColumnSpec[] {
    return this.plans.map((plan) => plan.spec);
  }

  /**
   * Applies the mapping, producing one row per selected element.
   *
   * `$$` paths always resolve against the whole blob, which is the only reason
   * fanning out is useful: a row per file that still knows its pull request
   * number.
   */
  apply(result: unknown, context: { rowId: () => string; at: Date; batch: string }): MappingResult {
    const sources = this.rowsPath ? readRows(result, this.rowsPath, 'rows') : [result];

    if (sources.length > MAX_ROWS_PER_ADD) {
      throw new InvariantViolation(
        `this mapping fans out into ${sources.length} rows, and one /add may write ` +
          `at most ${MAX_ROWS_PER_ADD}. Split the result and send it in batches.`,
      );
    }

    const at = context.at.toISOString();
    const rows = sources.map((source) => {
      const row: Record<string, Coerced> = {
        [ROW_ID]: context.rowId(),
        [INGESTED_AT]: at,
        [BATCH]: context.batch,
      };
      if (this.raw) row[RAW] = JSON.stringify(source);

      for (const plan of this.plans) {
        row[plan.spec.name.value] =
          plan.path === null
            ? plan.constant
            : coerce(
                readPath(plan.path.fromRoot ? result : source, plan.path),
                plan.spec.type,
                plan.spec.name.value,
              );
      }
      return row;
    });

    return { rows, columns: this.columns };
  }
}

function planFor(name: string, mapping: ColumnMapping): Plan {
  const hasFrom = typeof mapping.from === 'string' && mapping.from.length > 0;
  const hasValue = mapping.value !== undefined;

  if (hasFrom === hasValue) {
    throw new InvariantViolation(
      `column "${name}" must have exactly one of "from" (a path) or "value" (a constant)`,
    );
  }

  const spec = ColumnSpec.of({ name, type: mapping.type, embedded: mapping.embed });

  return {
    spec,
    path: hasFrom ? parsePath(mapping.from as string, `column "${name}".from`) : null,
    constant: hasValue ? coerce(mapping.value, spec.type, name) : null,
  };
}
