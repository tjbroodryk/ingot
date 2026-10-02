import type { MaterialisableTable } from './analytical-engine.port.js';
import { collectRelations } from './embedding-guard.js';

/**
 * Which of a table's expensive columns a query session can leave out.
 *
 * Materialising copies a table into the session whole, and two kinds of column
 * dominate what that costs while hardly any query reads them: the vectors —
 * 768 floats a row, staged as text on the way in — and `_raw`, the entire blob
 * a row was projected from. A query that does not name them gets a session
 * without them.
 *
 * Deliberately crude, and wrong only in the cheap direction. A column is kept
 * when its name appears anywhere in the statement as a word, which also keeps
 * it for a name in a string literal or a comment; that costs memory, never an
 * answer. The cases that could reach a column without naming it are covered
 * separately:
 *
 * - a vector reached through `*`, `t.*` or `COLUMNS(…)` is withheld from every
 *   result anyway, and the embedding guard refuses every route that would
 *   turn one into something else — so leaving it out changes nothing a caller
 *   could see;
 * - `_raw` has no such protection, so any star, any whole-row reference, and
 *   any statement the parse cannot read keeps it.
 *
 * Roll-ups never come through here: they write every column back out.
 */

const RAW = '_raw';

/** Where a column's embedding lands once materialised, beside its text. */
export function vectorColumnName(column: string): string {
  return `${column}_vec`;
}

export interface ColumnUsage {
  /** Every identifier-shaped word in the statement, lower-cased. */
  readonly words: ReadonlySet<string>;
  /**
   * Whether the statement can read columns it never names: a star, `t.*`,
   * `COLUMNS(…)`, a whole row by its table's name, or a statement whose parse
   * could not be read.
   */
  readonly wholeRows: boolean;
}

/** Every identifier-shaped word in `sql`, lower-cased. */
export function statementWords(sql: string): ReadonlySet<string> {
  return new Set((sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toLowerCase()));
}

/**
 * Whether a statement can need `column`'s vectors. The session builder asks
 * before reading the overlay, so it has to agree with `pruneTable`.
 */
export function namesVector(words: ReadonlySet<string>, column: string): boolean {
  return words.has(vectorColumnName(column).toLowerCase());
}

/** `serialized` is `json_serialize_sql(sql)`, parsed. */
export function columnUsage(
  sql: string,
  serialized: unknown,
  tables: readonly MaterialisableTable[],
): ColumnUsage {
  const words = statementWords(sql);
  if (
    serialized === null ||
    typeof serialized !== 'object' ||
    (serialized as { error?: boolean }).error === true
  ) {
    return { words, wholeRows: true };
  }

  const relations = new Set<string>();
  collectRelations(serialized, relations);
  const columns = new Set(
    tables.flatMap((table) => table.columns.map((column) => column.name.toLowerCase())),
  );
  return { words, wholeRows: readsWholeRows(serialized, relations, columns) };
}

/** `table` without the columns `usage` shows the statement cannot need. */
export function pruneTable(table: MaterialisableTable, usage: ColumnUsage): MaterialisableTable {
  const embedded = table.embedded.filter((entry) => namesVector(usage.words, entry.column));
  const keepRaw = usage.wholeRows || usage.words.has(RAW);
  const columns = keepRaw ? table.columns : table.columns.filter((column) => column.name !== RAW);
  if (embedded.length === table.embedded.length && columns.length === table.columns.length) {
    return table;
  }

  const kept = new Set(embedded.map((entry) => entry.column));
  // The sibling file holds every embedded column, so it goes only when none is kept.
  const vectorFiles = embedded.length > 0 ? table.vectorFiles : [];
  const dropped = new Set(table.vectorFiles.filter((uri) => !vectorFiles.includes(uri)));
  return {
    ...table,
    columns,
    embedded,
    vectorFiles,
    // Out of the lease too, so the Parquet cache does not fetch what nothing reads.
    sources: table.sources.filter((file) => !dropped.has(file.uri)),
    overlayVectors: table.overlayVectors.filter((vector) => kept.has(vector.column)),
  };
}

function readsWholeRows(
  value: unknown,
  relations: ReadonlySet<string>,
  columns: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) return value.some((item) => readsWholeRows(item, relations, columns));
  if (value === null || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;

  // `*`, `t.*` and `COLUMNS(…)` all parse to STAR. `count(*)` does not.
  if (node.class === 'STAR') return true;
  if (node.class === 'COLUMN_REF') {
    const names = (node.column_names as string[] | undefined) ?? [];
    const name = names[0]?.toLowerCase() ?? '';
    if (names.length === 1 && relations.has(name) && !columns.has(name)) return true;
  }
  return Object.values(node).some((child) => readsWholeRows(child, relations, columns));
}
