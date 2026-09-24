import { InvariantViolation } from '../../../shared/domain/index.js';

/**
 * A small path language, read in TypeScript, not JSONPath and not evaluated by
 * DuckDB. `$.a.b[0]` walks the current row; `$$.a.b` walks the whole blob; `[*]`
 * fans an array out and is only legal in the `rows` selector. `$["Invoice #"]`
 * reaches a key the dotted form cannot spell.
 */
export type Segment =
  { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'each' };

export interface ParsedPath {
  /** True for `$$`, meaning "resolve against the whole blob". */
  readonly fromRoot: boolean;
  readonly segments: readonly Segment[];
}

/** Marks the one place a fan-out is allowed, for a better error message. */
export function parsePath(raw: string, field: string, allowEach = false): ParsedPath {
  const trimmed = raw.trim();
  const fromRoot = trimmed.startsWith('$$');
  const marker = fromRoot ? '$$' : '$';
  if (!trimmed.startsWith(marker)) {
    throw new InvariantViolation(`${field} must start with "$" or "$$": got "${raw}"`);
  }

  const segments: Segment[] = [];
  let rest = trimmed.slice(marker.length);

  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const match = /^\.([A-Za-z0-9_\-\s]+)/.exec(rest);
      if (!match?.[1]) throw new InvariantViolation(`${field} has an empty key near "${rest}"`);
      segments.push({ kind: 'key', key: match[1] });
      rest = rest.slice(match[0].length);
      continue;
    }
    if (rest.startsWith('[')) {
      // Quoted key first: `["0"]` is a key and `[0]` is an index, and an object
      // may have `"0"` as a field name.
      const quoted = /^\[(["'])((?:\\.|(?!\1)[^\\])*)\1\]/.exec(rest);
      if (quoted) {
        const key = (quoted[2] ?? '').replace(/\\(.)/g, '$1');
        if (key.length === 0) {
          throw new InvariantViolation(`${field} has an empty quoted key near "${rest}"`);
        }
        segments.push({ kind: 'key', key });
        rest = rest.slice(quoted[0].length);
        continue;
      }

      const match = /^\[(\*|\d+)\]/.exec(rest);
      if (!match?.[1]) throw new InvariantViolation(`${field} has a bad subscript near "${rest}"`);
      if (match[1] === '*') {
        if (!allowEach) {
          throw new InvariantViolation(
            `${field} may not use [*] — a column must resolve to one value. ` +
              'Use "rows" to fan an array out into several rows.',
          );
        }
        segments.push({ kind: 'each' });
      } else {
        segments.push({ kind: 'index', index: Number(match[1]) });
      }
      rest = rest.slice(match[0].length);
      continue;
    }
    throw new InvariantViolation(`${field} is not a path this service understands: "${raw}"`);
  }

  return { fromRoot, segments };
}

/**
 * Walks a path to a single value. A missing step yields `undefined`, not an
 * error: an omitted field just reads null.
 */
export function readPath(value: unknown, path: ParsedPath): unknown {
  let current = value;
  for (const segment of path.segments) {
    if (current === null || current === undefined) return undefined;
    if (segment.kind === 'key') {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment.key];
    } else if (segment.kind === 'index') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.index];
    } else {
      // `each` in a value path is rejected at parse time.
      return undefined;
    }
  }
  return current;
}

/**
 * Resolves a fan-out selector to the rows it names. A selector that lands on a
 * non-array throws rather than returning empty, since a wrong path and no rows
 * look identical otherwise.
 */
export function readRows(blob: unknown, path: ParsedPath, field: string): unknown[] {
  const each = path.segments.findIndex((segment) => segment.kind === 'each');
  const upTo = each === -1 ? path.segments : path.segments.slice(0, each);
  const selected = readPath(blob, { fromRoot: path.fromRoot, segments: upTo });

  if (!Array.isArray(selected)) {
    throw new InvariantViolation(
      `${field} does not point at an array — found ${describe(selected)}. ` +
        'Omit "rows" to store the whole result as one row.',
    );
  }

  const after = each === -1 ? [] : path.segments.slice(each + 1);
  if (after.length === 0) return selected;
  return selected.map((item) => readPath(item, { fromRoot: false, segments: after }));
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
