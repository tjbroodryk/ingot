/** Rendering a credential into the SQL that installs it. Shared so both object stores escape identically. */

/**
 * A string literal for `CREATE SECRET`. Escaped so a secret containing `'` fails
 * to authenticate rather than to parse.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** DuckDB's `ENDPOINT` is a host, not a URL, and rejects the scheme. */
export function stripScheme(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
