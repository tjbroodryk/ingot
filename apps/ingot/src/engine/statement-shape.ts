import { InvariantViolation } from '../shared/domain/index.js';

/**
 * Two text-level checks the engine's type check cannot make on its own.
 *
 * `prepare().statementType` is the primary gate and catches almost everything.
 * These close the two gaps found by running actual attacks at it:
 *
 *  - DuckDB rewrites some `PRAGMA` statements into a select over a table
 *    function, so `PRAGMA database_list` arrives at `statementType` looking
 *    exactly like `SELECT 1`. The type is honest about what will run; it is
 *    not a record of what was written.
 *  - `/delete` takes a *predicate*, which this service wraps in
 *    `SELECT _row_id FROM t WHERE (…)`. A predicate carrying an unmatched
 *    `)` closes that wrapping and continues the statement — still one SELECT,
 *    so still past every check the engine makes.
 *
 * Both are text checks, which is usually a smell. They earn their place by
 * being *narrowing* rather than pattern-matching: neither tries to recognise
 * something bad, they establish something structural about the input and
 * refuse what does not fit.
 */

/** What a statement may begin with, once comments and whitespace are gone. */
const OPENERS = new Set(['select', 'with', 'from', 'values', 'table', 'describe', 'summarize']);

export function assertStartsAsSelect(sql: string): void {
  const keyword = leadingKeyword(sql);
  if (keyword === '(') return; // a parenthesised select
  if (keyword !== null && OPENERS.has(keyword)) return;

  throw new InvariantViolation(
    `A query must begin with SELECT (or WITH, FROM, VALUES), and this begins with ` +
      `"${keyword ?? 'nothing'}". An ingot is written through /add and /delete, ` +
      'never through the query endpoint.',
  );
}

/**
 * The first meaningful token, lowercased. `(` is returned as itself.
 *
 * Skips whitespace, `-- line comments` and `/* block comments *​/`, because a
 * statement may legitimately be introduced by one and an attacker will
 * certainly try.
 */
export function leadingKeyword(sql: string): string | null {
  let at = 0;
  for (;;) {
    while (at < sql.length && /\s/.test(sql[at] as string)) at++;

    if (sql.startsWith('--', at)) {
      const newline = sql.indexOf('\n', at);
      if (newline === -1) return null;
      at = newline + 1;
      continue;
    }
    if (sql.startsWith('/*', at)) {
      const close = sql.indexOf('*/', at + 2);
      if (close === -1) return null;
      at = close + 2;
      continue;
    }
    break;
  }

  if (at >= sql.length) return null;
  if (sql[at] === '(') return '(';

  const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(at));
  return word ? (word[0] as string).toLowerCase() : (sql[at] ?? null);
}

/**
 * Refuses a predicate that could close the statement it is wrapped in.
 *
 * Scanned outside string literals, the parentheses must never go negative and
 * must end balanced, and a `;` is refused outright. With that established,
 * a trailing `--` cannot reach anything: there is nothing left of our wrapping
 * for it to comment away, because the predicate never got out of its brackets.
 *
 * Doubled quotes (`'it''s'`) are handled by the loop below rather than by a
 * regular expression, because the version of this written with a regex is the
 * version that gets `''` wrong.
 */
export function assertSelfContainedPredicate(where: string): void {
  let depth = 0;
  let inString = false;
  let inIdentifier = false;

  for (let at = 0; at < where.length; at++) {
    const char = where[at];

    if (inString) {
      if (char === "'") {
        if (where[at + 1] === "'")
          at++; // an escaped quote, not the end
        else inString = false;
      }
      continue;
    }
    if (inIdentifier) {
      if (char === '"') {
        if (where[at + 1] === '"') at++;
        else inIdentifier = false;
      }
      continue;
    }

    if (char === "'") inString = true;
    else if (char === '"') inIdentifier = true;
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth < 0) {
        throw new InvariantViolation(
          'That predicate has an unmatched ")" — it would close the statement it is ' +
            'part of. A predicate is a condition, not a fragment of SQL.',
        );
      }
    } else if (char === ';') {
      throw new InvariantViolation('A predicate is one condition; it cannot contain ";"');
    }
  }

  if (depth !== 0) {
    throw new InvariantViolation('That predicate has an unclosed "("');
  }
  if (inString) {
    throw new InvariantViolation('That predicate has an unterminated string literal');
  }
}
