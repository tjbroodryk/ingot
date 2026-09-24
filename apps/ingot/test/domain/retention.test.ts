import { describe, expect, it } from 'bun:test';
import { Retention, RetentionUnit } from '../../src/contexts/ingots/domain/retention.vo.js';

/** How long a memory is kept. */
describe('a retention', () => {
  const start = new Date('2026-08-26T09:00:00.000Z');

  it.each([
    ['30m', 30 * 60_000],
    ['12h', 12 * 3_600_000],
    ['14d', 14 * 86_400_000],
    ['4w', 4 * 604_800_000],
    ['1m', 60_000],
  ])('reads %s', (raw, milliseconds) => {
    expect(Retention.of(raw).milliseconds).toBe(milliseconds);
  });

  it('computes the instant a memory falls due', () => {
    expect(Retention.of('14d').from(start).toISOString()).toBe('2026-09-09T09:00:00.000Z');
    expect(Retention.of('12h').from(start).toISOString()).toBe('2026-08-26T21:00:00.000Z');
  });

  it('accepts either case', () => {
    expect(Retention.of('14D').value).toBe('14d');
  });

  it.each([
    ['14 d', 'a space'],
    ['14', 'no unit'],
    ['d', 'no number'],
    ['14y', 'a unit that is not one of ours'],
    ['1.5d', 'a fraction'],
    ['-2d', 'a negative'],
    ['14d ; DROP TABLE ingot', 'anything trailing'],
    ['', 'nothing at all'],
  ])('refuses %s (%s)', (raw) => {
    expect(() => Retention.of(raw)).toThrow();
  });

  it('refuses a retention shorter than a minute', () => {
    expect(() => Retention.of('0m')).toThrow(/shorter than a minute/);
    expect(() => Retention.of('0d')).toThrow(/shorter than a minute/);
  });

  it('refuses a retention longer than ten years, and says what to do instead', () => {
    expect(() => Retention.of('9999w')).toThrow(/Omit retainFor/);
  });

  it('names its units as a closed set', () => {
    // Parsed against `Object.values`, never cast, so a unit with no millisecond value is a compile error.
    expect(Object.values(RetentionUnit).map(String).sort()).toEqual(['d', 'h', 'm', 'w']);
  });
});
