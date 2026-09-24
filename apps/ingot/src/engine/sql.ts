/**
 * Hand-built SQL, safely. A third layer under `SqlName` (name restriction) and
 * the single-SELECT gate, for the SQL this service generates: a manifest we
 * wrote is still not trusted input.
 */

/** Quotes an identifier, doubling embedded quotes; callers pick column names and some (`at`) are keywords. */
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
