/**
 * Refuses a statement that reads anything but the session's own tables.
 *
 * Views leave their Parquet readable after the lockdown (`allowed_paths`), and
 * read directly those files still hold forgotten rows and raw vectors. Applied
 * to every query, so what is allowed never depends on what was cached.
 *
 * A path in FROM (`FROM 'x.parquet'`) parses as a table named by the path and
 * DuckDB opens it, so a table name must be an identifier. `query()` builds its
 * SQL at runtime where no parse can see it, so table functions are an
 * allowlist rather than a denylist.
 */

/** Where a view's overlay, vectors and tombstones live, out of a caller's reach. */
export const INTERNAL_SCHEMA = '_ingot';

const TABLE_FUNCTIONS = new Set(['range', 'generate_series', 'unnest']);
const CATALOGUE_SCHEMAS = new Set(['information_schema', 'pg_catalog']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class OutsideTheSession extends Error {}

type Node = Record<string, unknown>;

/**
 * `serialized` is `json_serialize_sql(sql)`, parsed. `fullText` names the
 * tables whose `fts_main_<table>` schema a query may read. Returns nothing for
 * an unreadable parse: the caller must then build no views, which leaves the
 * lockdown refusing every file.
 */
export function assertReadsOnlySessionTables(
  serialized: unknown,
  fullText: ReadonlySet<string>,
): void {
  if (serialized === null || typeof serialized !== 'object') return;
  if ((serialized as { error?: boolean }).error) return;
  visit(serialized, fullText);
}

/** Whether `assertReadsOnlySessionTables` could read this parse at all. */
export function readable(serialized: unknown): boolean {
  return (
    serialized !== null &&
    typeof serialized === 'object' &&
    (serialized as { error?: boolean }).error !== true
  );
}

function visit(value: unknown, fullText: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fullText);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const node = value as Node;
  // Table references carry `type` but no `class`; expressions always have one.
  if (node.class === undefined) {
    if (node.type === 'TABLE_FUNCTION') checkFunction(node);
    if (node.type === 'BASE_TABLE') checkTable(node, fullText);
  }
  for (const child of Object.values(node)) visit(child, fullText);
}

function checkFunction(node: Node): void {
  const fn = node.function as Node | undefined;
  const name = String(fn?.function_name ?? '').toLowerCase();
  const schema = String(fn?.schema ?? '');
  if (schema === '' && TABLE_FUNCTIONS.has(name)) return;
  refuse(
    `${name || 'a table function'}() in FROM. The only table functions a query may call ` +
      `are ${[...TABLE_FUNCTIONS].join(', ')}`,
  );
}

function checkTable(node: Node, fullText: ReadonlySet<string>): void {
  const catalog = String(node.catalog_name ?? '');
  const schema = String(node.schema_name ?? '').toLowerCase();
  const table = String(node.table_name ?? '');

  if (catalog !== '' && catalog !== 'memory') refuse(`a table in catalogue "${catalog}"`);
  if (!IDENTIFIER.test(table)) refuse(`"${table}", which is not a table name`);
  if (schema === '' || schema === 'main') return;
  if (CATALOGUE_SCHEMAS.has(schema)) return;
  if (schema.startsWith('fts_main_') && fullText.has(schema.slice('fts_main_'.length))) return;
  refuse(`a table in schema "${schema}"`);
}

function refuse(what: string): never {
  throw new OutsideTheSession(
    `A query reads the ingot's tables and nothing else, and this one reaches for ${what}.`,
  );
}
