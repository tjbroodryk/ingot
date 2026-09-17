/**
 * Refuses a statement that could carry an embedding out of the session.
 *
 * `embeddingColumns` in the engine withholds a result column whose type is a
 * fixed-width array, and that catches a vector selected as it is. It cannot
 * catch one that stopped being an array on the way out — `body_vec::VARCHAR`,
 * `body_vec[1]`, `to_json(body_vec)`, `unnest(body_vec::FLOAT[])` — because by
 * then the result column is text or a number. So this reads the statement
 * DuckDB parsed and allows a vector in exactly the places that cannot return
 * one:
 *
 * - as an argument to a similarity function whose other arguments are `$q` or
 *   vectors, which returns a score;
 * - under `IS NULL` / `IS NOT NULL`, which returns a boolean;
 * - as an item of the outermost select list, where the result filter drops it.
 *
 * `$q` is the same rule from the other side: it is the embedding of the
 * caller's text, and is only ever a similarity argument.
 *
 * The rest closes the routes around a column reference rather than through
 * one: a whole row referenced by its table's name (a struct, vector inside), a
 * star anywhere but a select list, positional references, set operations
 * (their branches are not the outermost select list), PIVOT and SHOW, and the
 * table functions that run SQL handed to them as a string.
 */

const SIMILARITY = new Set([
  'array_cosine_similarity',
  'array_cosine_distance',
  'array_distance',
  'array_inner_product',
  'array_negative_inner_product',
  'array_dot_product',
  'array_negative_dot_product',
]);

/** Table functions that execute a string or a serialised plan the parse cannot see into. */
const OPAQUE_FUNCTIONS = new Set(['query', 'query_table', 'json_execute_serialized_sql']);

const ALLOWED_TABLE_REFS = new Set([
  'BASE_TABLE',
  'SUBQUERY',
  'JOIN',
  'TABLE_FUNCTION',
  'EXPRESSION_LIST',
  'EMPTY',
  'EMPTY_FROM',
]);

export interface EmbeddingScope {
  /** Every vector column the session materialises, e.g. `body_vec`. */
  readonly vectors: ReadonlySet<string>;
  /** Every declared column of every table, to tell a column from a table name. */
  readonly columns: ReadonlySet<string>;
}

type Node = Record<string, unknown>;

export class EmbeddingEscape extends Error {}

/**
 * `serialized` is `json_serialize_sql(sql)`, parsed. Throws `EmbeddingEscape`
 * naming what it found; returns nothing when the statement is clean.
 */
export function assertNoEmbeddingEscape(serialized: unknown, scope: EmbeddingScope): void {
  const vectors = lower(scope.vectors);
  if ((serialized as { error?: boolean }).error) {
    // DuckDB runs some SELECTs it cannot serialise. With nothing to leak that
    // is fine; with vectors in the session, unread is not the same as clean.
    if (vectors.size > 0) refuse('a statement this check cannot read');
    return;
  }
  if (vectors.size === 0 && !mentionsParameter(serialized)) return;

  const statements = (serialized as { statements?: unknown[] }).statements ?? [];
  const relations = new Set<string>();
  collectRelations(serialized, relations);
  const columns = lower(scope.columns);

  for (const statement of statements) {
    const root = (statement as Node).node as Node | undefined;
    if (root) walk(root, [], { root, vectors, relations, columns });
  }
}

interface WalkState {
  readonly root: Node;
  readonly vectors: ReadonlySet<string>;
  readonly relations: ReadonlySet<string>;
  readonly columns: ReadonlySet<string>;
}

function walk(value: unknown, ancestors: readonly Node[], state: WalkState): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, ancestors, state);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const node = value as Node;
  check(node, ancestors, state);

  const next = [...ancestors, node];
  for (const child of Object.values(node)) walk(child, next, state);
}

function check(node: Node, ancestors: readonly Node[], state: WalkState): void {
  const parent = ancestors.at(-1);

  if (node.class === 'POSITIONAL_REFERENCE') refuse('a positional column reference (#n)');

  switch (node.class) {
    case 'COLUMN_REF': {
      const names = (node.column_names as string[] | undefined) ?? [];
      const name = names.at(-1)?.toLowerCase() ?? '';

      if (state.vectors.has(name)) {
        if (isSimilarityArgument(parent, state) || isNullCheck(parent)) return;
        if (isOutermostSelectItem(node, parent, state.root)) return;
        refuse(`${names.join('.')} used as anything but a similarity argument`);
      }
      if (names.length === 1 && state.relations.has(name) && !state.columns.has(name)) {
        refuse(`the whole row of "${names[0]}", which carries its embeddings`);
      }
      return;
    }

    case 'PARAMETER':
      if (!isSimilarityArgument(parent, state)) {
        refuse('$q used as anything but a similarity argument');
      }
      return;

    case 'STAR':
      // A select list item, at any depth: its vectors stay arrays, so they are
      // dropped at the end unless something above names them, which is checked.
      // Not under a set operation, which may cast a branch's array to match the
      // other branch — `UNION ALL BY NAME SELECT 'x' AS body_vec` makes it text.
      if (ancestors.some((ancestor) => ancestor.type === 'SET_OPERATION_NODE')) {
        refuse('* under UNION, EXCEPT or INTERSECT');
      }
      if (!(parent && Array.isArray(parent.select_list) && parent.select_list.includes(node))) {
        refuse('* or COLUMNS(…) inside an expression');
      }
      return;

    case 'FUNCTION':
      if (OPAQUE_FUNCTIONS.has(String(node.function_name).toLowerCase())) {
        refuse(`${String(node.function_name)}(), which runs SQL this check cannot read`);
      }
      return;
  }

  // Table references carry `type` but no `class`.
  if (node.class === undefined && typeof node.type === 'string' && isTableRef(node, ancestors)) {
    if (!ALLOWED_TABLE_REFS.has(node.type)) {
      refuse(`a ${node.type.toLowerCase().replace('_', ' ')} in FROM`);
    }
  }
}

function isSimilarityArgument(parent: Node | undefined, state: WalkState): boolean {
  if (parent?.class !== 'FUNCTION') return false;
  if (!SIMILARITY.has(String(parent.function_name).toLowerCase())) return false;

  const children = (parent.children as Node[] | undefined) ?? [];
  return children.every(
    (child) =>
      child.class === 'PARAMETER' ||
      (child.class === 'COLUMN_REF' &&
        state.vectors.has(
          String((child.column_names as string[] | undefined)?.at(-1) ?? '').toLowerCase(),
        )),
  );
}

function isNullCheck(parent: Node | undefined): boolean {
  return parent?.type === 'OPERATOR_IS_NULL' || parent?.type === 'OPERATOR_IS_NOT_NULL';
}

function isOutermostSelectItem(node: Node, parent: Node | undefined, root: Node): boolean {
  return parent === root && Array.isArray(root.select_list) && root.select_list.includes(node);
}

function isTableRef(node: Node, ancestors: readonly Node[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  return (
    parent.from_table === node ||
    (parent.type === 'JOIN' && (parent.left === node || parent.right === node)) ||
    (parent.type === 'PIVOT' && parent.source === node)
  );
}

/** Table names, aliases and CTE names: anything a bare identifier could mean as a row. */
function collectRelations(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRelations(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const node = value as Node;
  if (node.class === undefined) {
    if (typeof node.table_name === 'string' && node.table_name) {
      into.add(node.table_name.toLowerCase());
    }
    if (typeof node.alias === 'string' && node.alias) into.add(node.alias.toLowerCase());
  }
  const cte = node.cte_map as { map?: { key: string }[] } | undefined;
  for (const entry of cte?.map ?? []) into.add(entry.key.toLowerCase());

  for (const child of Object.values(node)) collectRelations(child, into);
}

function mentionsParameter(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsParameter);
  if (value === null || typeof value !== 'object') return false;
  const node = value as Node;
  return node.class === 'PARAMETER' || Object.values(node).some(mentionsParameter);
}

function lower(values: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...values].map((value) => value.toLowerCase()));
}

function refuse(what: string): never {
  throw new EmbeddingEscape(
    `Embeddings are never returned, and this query could return one: ${what}. ` +
      'A vector column (<column>_vec) and $q may only be arguments to a similarity function ' +
      '— array_cosine_similarity(<column>_vec, $q) — or checked with IS NULL.',
  );
}
