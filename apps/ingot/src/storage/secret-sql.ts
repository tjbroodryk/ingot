/**
 * Rendering a credential into the SQL that installs it.
 *
 * Two functions, shared by the object stores that install a secret, because a
 * second copy of either is where one of them stops escaping.
 */

/**
 * A string literal for `CREATE SECRET`.
 *
 * These values are configuration and never caller input, so the literal is safe
 * already. It is still escaped, because a secret with an apostrophe in it
 * should fail to authenticate rather than fail to parse — which is a wholly
 * different afternoon for whoever is reading the error.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** DuckDB's `ENDPOINT` is a host, not a URL, and rejects the scheme. */
export function stripScheme(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
