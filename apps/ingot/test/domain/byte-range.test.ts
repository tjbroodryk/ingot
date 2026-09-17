import { describe, expect, it } from 'bun:test';
import { byteRange } from '../../src/contexts/records/interface/byte-range.js';

describe('a Range header', () => {
  it.each([
    ['a closed range', 'bytes=0-3', { start: 0, end: 3 }],
    ['an open-ended range', 'bytes=96-', { start: 96, end: 99 }],
    ['a suffix', 'bytes=-8', { start: 92, end: 99 }],
    ['a suffix longer than the object', 'bytes=-500', { start: 0, end: 99 }],
    ['an end past the object', 'bytes=90-500', { start: 90, end: 99 }],
  ])('reads %s', (_, header, expected) => {
    expect(byteRange(header, 100)).toEqual(expected);
  });

  it.each([
    ['no header', undefined],
    ['another unit', 'items=0-3'],
    ['several ranges', 'bytes=0-3,8-9'],
    ['nonsense', 'bytes=abc'],
    ['an end before its start', 'bytes=9-3'],
  ])('serves the whole object for %s', (_, header) => {
    expect(byteRange(header, 100)).toBeNull();
  });

  it('refuses a range that starts past the end', () => {
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});
