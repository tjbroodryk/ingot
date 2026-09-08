import { describe, expect, test } from 'bun:test';
import { pool } from '../src/run/pool.js';

/**
 * The bounded worker, which the runner leans on for two separate promises.
 *
 * The obvious one is that it overlaps work. The load-bearing one is that it
 * returns results in *item* order however they finished, because that is what
 * makes a report at `--concurrency 8` byte-identical to the same run serial. A
 * benchmark whose table depends on how fast the provider happened to answer is
 * not a benchmark.
 */

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('pool', () => {
  test('returns results in item order, not completion order', async () => {
    // Deliberately inverted: the first item finishes last.
    const delays = [40, 30, 20, 10, 0];
    const finished: number[] = [];

    const results = await pool(delays, 5, async (delay, index) => {
      await tick(delay);
      finished.push(index);
      return index;
    });

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(finished).toEqual([4, 3, 2, 1, 0]);
  });

  test('never exceeds the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;

    await pool(Array.from({ length: 20 }, (_, index) => index), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });

    expect(peak).toBe(4);
  });

  test('a limit of one is serial, which is what the default has to mean', async () => {
    let inFlight = 0;
    let peak = 0;

    await pool([1, 2, 3, 4], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight -= 1;
    });

    expect(peak).toBe(1);
  });

  test('actually overlaps: ten 20ms items at four wide beat serial', async () => {
    const started = Date.now();
    await pool(Array.from({ length: 10 }, (_, index) => index), 4, () => tick(20));
    const elapsed = Date.now() - started;

    // Serial would be 200ms; three batches of four is ~60ms. The bound is loose
    // because timers are not promises about wall clock, but it is far enough
    // below 200ms to catch a pool that silently stopped overlapping.
    expect(elapsed).toBeLessThan(150);
  });
});
