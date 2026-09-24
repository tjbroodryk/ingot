import { describe, expect, it } from 'bun:test';
import { sizeOf } from '../../src/contexts/records/domain/payload-size.js';

/** Size of a stored payload — approximately right, and fast because it runs on every one. */
describe('measuring a payload', () => {
  it('counts the bytes of the compact JSON, not of a rendering of it', () => {
    const size = sizeOf({ a: 1, b: 'two' });

    expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1, b: 'two' }), 'utf8'));
    expect(size.estimatedTokens).toBeGreaterThan(0);
  });

  it('counts bytes rather than characters', () => {
    // A multi-byte character is one string character but several bytes.
    const size = sizeOf({ text: '日本語' });

    expect(size.bytes).toBeGreaterThan(JSON.stringify({ text: '日本語' }).length);
  });

  it('reports kibibytes to one place, rounded rather than truncated', () => {
    const size = sizeOf({ pad: 'x'.repeat(1_536) });

    // 1_536 bytes is ~1.5 KiB; truncation would report 1.
    expect(size.kilobytes).toBeGreaterThan(1.4);
    expect(size.kilobytes).toBeLessThan(1.7);
  });

  it('is cheap on a payload far larger than anything it should measure', () => {
    // The token count is extrapolated from a prefix above a cap, so this stays fast.
    const huge = { rows: Array.from({ length: 40_000 }, (_at, n) => ({ n, note: 'a line' })) };

    const started = performance.now();
    const size = sizeOf(huge);
    const elapsed = performance.now() - started;

    expect(size.bytes).toBeGreaterThan(1_000_000);
    expect(size.estimatedTokens).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('survives a payload that will not serialise', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => sizeOf(circular)).not.toThrow();
    expect(sizeOf(circular).bytes).toBeGreaterThan(0);
  });

  it('measures null and empty results without pretending they are missing', () => {
    // `null` serialises to the 4 bytes "null".
    expect(sizeOf(null).bytes).toBe(4);
    expect(sizeOf({}).bytes).toBe(2);
  });
});
