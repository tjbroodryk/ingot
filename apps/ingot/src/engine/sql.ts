/**
 * Building SQL by hand, safely.
 *
 * Nothing in this file is a substitute for the two boundaries that actually
 * hold: `SqlName` restricts table and column names to `[a-z_][a-z0-9_]*` at
 * the edge, and the query session refuses anything that is not a single
 * SELECT. These are the third layer, and they exist because the first two
 * protect the *caller's* SQL — the SQL this service generates around it is
 * built here, and a manifest is not a trusted input just because we wrote it.
 */

/**
 * `at` is a DuckDB keyword and callers pick column names, so every identifier
 * this service emits is quoted. Embedded quotes are doubled, which is what
 * makes the quoting a boundary rather than a decoration.
 */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A string literal. Only ever used for values this service produced. */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A `FLOAT[N]` array literal, for binding a query vector into a comparison. */
export function floatArray(values: readonly number[]): string {
  const rendered = values
    .map((value) => (Number.isFinite(value) ? value.toString() : '0'))
    .join(', ');
  return `[${rendered}]::FLOAT[${values.length}]`;
}

/** A list of file references for `read_parquet([...])`. */
export function uriList(uris: readonly string[]): string {
  return `[${uris.map(literal).join(', ')}]`;
}
