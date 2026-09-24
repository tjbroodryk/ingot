import { describe, expect, it } from 'bun:test';
import { BackgroundKind, CONCURRENCY } from '../../src/contexts/records/application/background.js';
import {
  BackgroundMisconfigured,
  CONCURRENCY_KEYS,
  MAX_CONCURRENCY,
  concurrencyFrom,
} from '../../src/contexts/records/application/background-settings.js';

/**
 * How much of somebody else's service a deployment will use at once.
 *
 * Configurable because the right number depends on a quota and the replica
 * count, neither of which this repository knows. Checked because getting it
 * wrong arrives as a slow queue, not an error. Pure: a function over a reader.
 */

/** An environment, as `ConfigService.get` would present it. */
function env(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

describe('the background concurrency', () => {
  it('falls back to the numbers this service ships with', () => {
    expect(concurrencyFrom(env({}))).toEqual(CONCURRENCY);
  });

  it('reads a bound for every queue there is', () => {
    const bounds = concurrencyFrom(
      env({
        INGOT_EMBEDDINGS_CONCURRENCY: '8',
        INGOT_RECEIPTS_CONCURRENCY: '4',
        INGOT_DELIVERIES_CONCURRENCY: '16',
        INGOT_FILES_CONCURRENCY: '3',
      }),
    );

    expect(bounds).toEqual({
      [BackgroundKind.Embeddings]: 8,
      [BackgroundKind.Receipts]: 4,
      [BackgroundKind.Deliveries]: 16,
      [BackgroundKind.Files]: 3,
    });
  });

  /**
   * A queue with no variable would be untunable; the `Record` makes that a
   * compile error, and this checks the names are real rather than plausible.
   */
  it('names a variable for every kind, and no two the same', () => {
    const keys = Object.values(BackgroundKind).map((kind) => CONCURRENCY_KEYS[kind]);

    expect(keys.length).toBe(Object.values(BackgroundKind).length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key.startsWith('INGOT_')).toBe(true);
  });

  it('leaves the queues nobody configured alone', () => {
    const bounds = concurrencyFrom(env({ INGOT_RECEIPTS_CONCURRENCY: '5' }));

    expect(bounds[BackgroundKind.Receipts]).toBe(5);
    expect(bounds[BackgroundKind.Embeddings]).toBe(CONCURRENCY[BackgroundKind.Embeddings]);
  });

  /** A deployment template left blank is not a deployment that configured one. */
  it('reads an empty variable as an unset one', () => {
    expect(concurrencyFrom(env({ INGOT_EMBEDDINGS_CONCURRENCY: '   ' }))).toEqual(CONCURRENCY);
  });

  it('accepts one, which is a queue worked a drain at a time', () => {
    expect(concurrencyFrom(env({ INGOT_EMBEDDINGS_CONCURRENCY: '1' }))).toMatchObject({
      [BackgroundKind.Embeddings]: 1,
    });
  });

  it.each([
    ['0', 'a queue that would never drain'],
    ['-1', 'a negative'],
    ['2.5', 'a fraction of a drain'],
    ['many', 'not a number at all'],
    ['1e2', 'a number nobody typed on purpose'],
  ])('refuses %s (%s)', (raw) => {
    expect(() => concurrencyFrom(env({ INGOT_EMBEDDINGS_CONCURRENCY: raw }))).toThrow(
      BackgroundMisconfigured,
    );
  });

  /** The cap is a typo guard, not a real limit: it catches `1000` typed for `100`. */
  it('takes the cap, and refuses one past it', () => {
    const at = String(MAX_CONCURRENCY);
    expect(concurrencyFrom(env({ INGOT_DELIVERIES_CONCURRENCY: at }))).toMatchObject({
      [BackgroundKind.Deliveries]: MAX_CONCURRENCY,
    });

    const over = String(MAX_CONCURRENCY + 1);
    expect(() => concurrencyFrom(env({ INGOT_DELIVERIES_CONCURRENCY: over }))).toThrow(
      /per replica/,
    );
  });

  /** The message has to name the variable: only its author can unset it. */
  it('says which variable it refused', () => {
    expect(() => concurrencyFrom(env({ INGOT_RECEIPTS_CONCURRENCY: '0' }))).toThrow(
      /INGOT_RECEIPTS_CONCURRENCY/,
    );
  });
});
