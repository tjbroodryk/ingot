import type { ByteRange } from '../../../storage/object-store.port.js';

/**
 * A `Range` header against an object of `size` bytes.
 *
 * `null` means serve the whole object: no header, a unit other than bytes, a
 * malformed value, or more than one range — all of which RFC 9110 lets a server
 * answer with a 200. `unsatisfiable` is the one case it does not: a range that
 * starts past the end, which is a 416.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, first, last] = match;
  if (first === '' && last === '') return null;

  if (first === '') {
    // A suffix: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return end < start ? null : { start, end };
}
