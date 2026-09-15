import { createHash } from 'node:crypto';
import type { QueryBody } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../../../shared/domain/index.js';

/**
 * Where a paged query got to, handed to the caller and back.
 *
 * An offset, and nothing that pins the data: rows written or forgotten between
 * two pages move what the next one holds, as `LIMIT … OFFSET` does against any
 * database that is still being written to.
 *
 * It carries a fingerprint of the question, so a cursor sent back with
 * different SQL is refused rather than answering some other query from its
 * middle. `limit` is left out of that: changing the page size between pages is
 * harmless. Not signed — editing one only moves where the caller's own query
 * resumes.
 */
export const QueryCursor = {
  encode(body: QueryBody, offset: number): string {
    return Buffer.from(JSON.stringify({ o: offset, h: fingerprint(body) })).toString('base64url');
  },

  /** The offset a request resumes from. Zero when it sends no cursor. */
  offset(body: QueryBody): number {
    if (body.cursor === undefined) return 0;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8'));
    } catch {
      // Refused below, with the same message as any other malformed cursor.
    }
    const { o, h } = (parsed ?? {}) as { o?: unknown; h?: unknown };
    if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0 || typeof h !== 'string') {
      throw new InvariantViolation(
        '"cursor" is not one this endpoint issued. Send the "next" of a previous result, unchanged.',
      );
    }
    if (h !== fingerprint(body)) {
      throw new InvariantViolation(
        '"cursor" belongs to a different query. Send it with the same sql, text, table and ' +
          'column as the request that returned it.',
      );
    }
    return o;
  },
};

function fingerprint(body: QueryBody): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        body.sql ?? null,
        body.text ?? null,
        body.table ?? null,
        body.column ?? null,
      ]),
    )
    .digest('base64url')
    .slice(0, 16);
}
