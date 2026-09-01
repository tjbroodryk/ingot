import { describe, expect, it } from 'bun:test';
import { sizeOf } from '../../src/contexts/records/domain/payload-size.js';

/**
 * What `/add` says a stored result cost.
 *
 * The number an agent uses to decide whether it can afford to pull a tool
 * result back into its own context. Being approximately right matters; being
 * fast matters as much, because `/add` accepts whatever a caller sends and
 * this runs on every one of them.
 */
describe('measuring a payload', () => {
  it('counts the bytes of the compact JSON, not of a rendering of it', () => {
    // Pretty-printing would inflate both numbers by whatever a formatter felt
    // like, and this is a claim about the data.
    const size = sizeOf({ a: 1, b: 'two' });

    expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1, b: 'two' }), 'utf8'));
    expect(size.estimatedTokens).toBeGreaterThan(0);
  });

  it('counts bytes rather than characters', () => {
    // A multi-byte character is one character and several bytes, and it is the
    // bytes that were stored.
    const size = sizeOf({ text: '日本語' });

    expect(size.bytes).toBeGreaterThan(JSON.stringify({ text: '日本語' }).length);
  });

  it('reports kibibytes to one place, rounded rather than truncated', () => {
    const size = sizeOf({ pad: 'x'.repeat(1_536) });

    // ~1.5 KiB, not 1 — a truncating conversion makes every payload under
    // 2 KiB look like it is 1 KiB, which is useless for a budget.
    expect(size.kilobytes).toBeGreaterThan(1.4);
    expect(size.kilobytes).toBeLessThan(1.7);
  });

  it('is cheap on a payload far larger than anything it should measure', () => {
    // Tokenising is linear and a caller chooses the length, so the count is
    // extrapolated from a prefix above a cap. Without it a large result makes
    // a caller's own write slow for a number they did not ask to be exact.
    const huge = { rows: Array.from({ length: 40_000 }, (_at, n) => ({ n, note: 'a line' })) };

    const started = performance.now();
    const size = sizeOf(huge);
    const elapsed = performance.now() - started;

    expect(size.bytes).toBeGreaterThan(1_000_000);
    expect(size.estimatedTokens).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('survives a payload that will not serialise', () => {
    // Circular structures cannot arrive over HTTP, but the MCP surface builds
    // the same command from a tool call without passing through a parse.
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => sizeOf(circular)).not.toThrow();
    expect(sizeOf(circular).bytes).toBeGreaterThan(0);
  });

  it('measures null and empty results without pretending they are missing', () => {
    // `null` is a legitimate tool result, and "no bytes" would be a lie.
    expect(sizeOf(null).bytes).toBe(4);
    expect(sizeOf({}).bytes).toBe(2);
  });
});
