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
 * The projection from a document to typed rows, checked before any bytes move.
 *
 * **This is validated at upload and not in the worker**, which is the same
 * argument `/add` makes about its mapping and a stronger one here. At `/add`, a
 * bad path is a 422 to the person still holding the response. At `/file` the
 * work happens minutes later in a sweeper, by which time the caller is gone and
 * the only place left to say anything is a `status` column they have to think
 * to read. So everything that can be refused is refused while somebody is still
 * listening, and what reaches the worker is a mapping already known to parse.
 *
 * ## Two ways to fill a column, and the file decides which
 *
 * A **tabular** document — a CSV, a sheet — already has rows and field names.
 * Its columns are filled by `from` paths that resolve against the parsed rows,
 * exactly as at `/add`, and **no model is called at all**. That is not a
 * fallback: it is the better answer, and it means structured import costs a
 * parser and nothing else.
 *
 * A **prose** document has neither, so its columns carry `describe` — a
 * sentence handed down as a schema the provider is held to, the same trick
 * `RECEIPT_SCHEMA` plays. What comes back is projected through the ordinary
 * mapping, so a model answering `"thirty"` for an `INTEGER` fails the same
 * coercion a bad `/add` fails rather than quietly widening the column.
 *
 * Mixing them is refused rather than resolved. A mapping that is half paths and
 * half descriptions is a mapping whose author has not decided what they
 * uploaded, and guessing on their behalf produces a table half-filled from a
 * model and half from a header row, with nothing recording which.
 *
 * ## What this deliberately does not do yet
 *
 * **`rows` is tabular-only.** Fanning a prose document out into many rows — the
 * line items on a scanned invoice — needs a nested schema and a policy for
 * merging what several page-windows each returned, and half of that is worse
 * than none: it produces duplicate rows on long documents and nothing says so.
 * One document is one row until that is built properly.
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
    // The caller's own table, so `SqlName.table` and not `systemTable`: an
    // extraction may not write into `ingot_files` or `ingot_file_chunks` any more
    // than an `/add` may write into `ingot_receipts`.
    const table = SqlName.table(extraction.table);

    const entries = Object.entries(extraction.columns ?? {});
    Guard.notEmpty(entries, `extract.columns for "${table.value}"`);
    Guard.inRange(entries.length, 1, MAX_COLUMNS, `extract.columns for "${table.value}"`);

    const columns = entries.map(([name, mapping]) => columnOf(name, mapping, source.tabular));

    /*
     * The paths, parsed here and thrown away.
     *
     * This is the whole reason the class exists rather than the worker simply
     * calling `RowMapping` when it gets there. A path is checked by parsing it,
     * and if the only place that happens is inside the worker then a typo in
     * `$.Invoice #` is discovered minutes later, four attempts deep, with the
     * caller long gone and the only evidence a `status` column they have to
     * think to read.
     *
     * So they are parsed twice: once now, to refuse the mapping while somebody
     * is still holding the response, and once in `RowMapping` when there is
     * finally a document to apply them to. The second parse is not redundant —
     * it is the one that does the work — and this one costs microseconds to
     * turn a silent failure into a 422.
     */
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
   * This is the whole reason extraction is shaped like this. Once a document
   * has become JSON — by a parser reading a header row, or by a model answering
   * a schema — what is left to do is precisely an `/add`, so it goes through
   * `RowMapping` rather than through a second projection that would have its
   * own paths, its own coercion and its own opinions about types.
   *
   * A model-filled column becomes `$.<name>`, because the schema handed to the
   * provider is a flat object keyed by column name. That is the join between
   * the two halves, and it is one line rather than a format.
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

/**
 * One column, and the check that it is filled exactly one way.
 *
 * The error names the way that *would* have worked for the document actually
 * uploaded, rather than listing all three: somebody who wrote `describe` on a
 * CSV column has made a specific mistake and the useful sentence names it.
 */
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

  // Refused here rather than left to the model, because the failure is silent:
  // a JSON column filled from prose is a model inventing a nested shape nobody
  // declared, and every query over it then depends on what it felt like
  // returning that day.
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
