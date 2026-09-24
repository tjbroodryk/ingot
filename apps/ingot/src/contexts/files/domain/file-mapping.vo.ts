import {
  type ColumnMapping,
  ColumnType,
  type ExtractMapping,
  type FileExtraction,
} from '@ingot/shared/ingot-v1';
import { Guard, InvariantViolation } from '../../../shared/domain/index.js';
import { ColumnSpec, SqlName } from '../../ingots/domain/index.js';
import { parsePath } from '../../records/domain/json-path.js';

/** How many columns one extraction may declare. A schema, not a warehouse. */
const MAX_COLUMNS = 64;

/** Enough for a real instruction, short enough not to be a prompt injection. */
const MAX_DESCRIPTION = 500;

/** One column of an extraction, checked. */
export interface ExtractedColumn {
  readonly spec: ColumnSpec;
  /** A path into the parsed document. Null for a column a model fills. */
  readonly from: string | null;
  readonly value: string | number | boolean | null | undefined;
  /** What to tell a model this column is. Null for a column a path fills. */
  readonly describe: string | null;
}

/**
 * The projection from a document to typed rows, checked at upload.
 *
 * A tabular document fills columns from `from` paths with no model. A prose
 * document fills them from `describe`, a schema a model answers. Mixing the two
 * is refused, and `rows` is tabular-only.
 */
export class FileMapping {
  private constructor(
    readonly table: SqlName,
    readonly key: readonly string[],
    readonly rows: string | null,
    readonly columns: readonly ExtractedColumn[],
    /** Whether these columns are filled by paths or by a model. */
    readonly fromPaths: boolean,
  ) {}

  static parse(extraction: FileExtraction, source: { tabular: boolean }): FileMapping {
    // The caller's own table: `SqlName.table` refuses the reserved prefix.
    const table = SqlName.table(extraction.table);

    const entries = Object.entries(extraction.columns ?? {});
    Guard.notEmpty(entries, `extract.columns for "${table.value}"`);
    Guard.inRange(entries.length, 1, MAX_COLUMNS, `extract.columns for "${table.value}"`);

    const columns = entries.map(([name, mapping]) => columnOf(name, mapping, source.tabular));

    // Paths parsed here and thrown away, only to refuse a bad one at upload;
    // `RowMapping` parses them again when there is a document to apply them to.
    for (const column of columns) {
      if (column.from !== null) parsePath(column.from, `column "${column.spec.name.value}".from`);
    }
    if (extraction.rows) parsePath(extraction.rows, 'extract.rows', true);

    if (!source.tabular && extraction.rows) {
      throw new InvariantViolation(
        `"extract.rows" fans a parsed structure out into many rows, and this document has no ` +
          'structure to fan out — a model reads it as prose and fills one row. Upload a CSV or ' +
          'a spreadsheet to use "rows", or drop it and extract one row per document.',
      );
    }

    const declared = new Set(columns.map((column) => column.spec.name.value));
    const key = (extraction.key ?? []).map((column) => String(column).toLowerCase());
    for (const named of key) {
      if (!declared.has(named)) {
        throw new InvariantViolation(
          `"extract.key" names "${named}", which this extraction does not fill. A key must ` +
            'name columns the write actually sets.',
        );
      }
    }

    return new FileMapping(table, key, extraction.rows ?? null, columns, source.tabular);
  }

  get specs(): readonly ColumnSpec[] {
    return this.columns.map((column) => column.spec);
  }

  /**
   * The same mapping as an `/add` would have written it.
   *
   * A model-filled column becomes `$.<name>`, matching the flat schema handed to
   * the provider.
   */
  asColumnMappings(): Record<string, ColumnMapping> {
    const mappings: Record<string, ColumnMapping> = {};

    for (const column of this.columns) {
      const name = column.spec.name.value;
      mappings[name] =
        column.from !== null
          ? { from: column.from, type: column.spec.type, embed: column.spec.embedded }
          : column.describe !== null
            ? { from: `$.${name}`, type: column.spec.type, embed: column.spec.embedded }
            : { value: column.value ?? null, type: column.spec.type, embed: column.spec.embedded };
    }
    return mappings;
  }
}

/** One column, checked to be filled exactly one way. */
function columnOf(name: string, mapping: ExtractMapping, tabular: boolean): ExtractedColumn {
  const hasFrom = typeof mapping.from === 'string' && mapping.from.length > 0;
  const hasValue = mapping.value !== undefined;
  const hasDescription = typeof mapping.describe === 'string' && mapping.describe.length > 0;

  const ways = [hasFrom, hasValue, hasDescription].filter(Boolean).length;
  if (ways !== 1) {
    throw new InvariantViolation(
      `column "${name}" must have exactly one of "from" (a path into the parsed document), ` +
        '"describe" (a sentence for a model to fill it from), or "value" (a constant); ' +
        `it has ${ways}`,
    );
  }

  if (tabular && hasDescription) {
    throw new InvariantViolation(
      `column "${name}" is declared with "describe", but this document already has field names ` +
        'of its own — give it a "from" path and no model is needed at all. That is cheaper and ' +
        'exact, which is why it is the rule rather than a preference.',
    );
  }
  if (!tabular && hasFrom) {
    throw new InvariantViolation(
      `column "${name}" is declared with the path "${mapping.from}", but this document is prose ` +
        'and has nothing to path into. Describe what the column is and a model fills it.',
    );
  }
  if (hasDescription) {
    Guard.maxLength(mapping.describe as string, MAX_DESCRIPTION, `column "${name}".describe`);
  }

  const spec = ColumnSpec.of({ name, type: mapping.type, embedded: mapping.embed });

  // A model-filled JSON column is refused: the model would invent a different
  // nested shape each time.
  if (hasDescription && spec.type === ColumnType.Json) {
    throw new InvariantViolation(
      `column "${name}" is declared JSON and filled by a model. A model asked for a shape ` +
        'nobody declared invents one, and it invents a different one next time — declare the ' +
        'fields you want as columns instead.',
    );
  }

  return {
    spec,
    from: hasFrom ? (mapping.from as string) : null,
    value: mapping.value,
    describe: hasDescription ? (mapping.describe as string) : null,
  };
}
