import type { Drained } from '../contexts/records/application/drained.js';

/**
 * Runs `drain` until the queue is empty or `everyMs` has elapsed.
 *
 * `Drained.more` means the worker stopped on its own bound, not an empty queue.
 * The deadline is checked between drains, so a run overruns by at most one drain
 * rather than interrupting a drain mid-lease.
 */
export async function drainWithin(everyMs: number, drain: () => Promise<Drained>): Promise<number> {
  const deadline = Date.now() + everyMs;
  let total = 0;

  for (;;) {
    const drained = await drain();
    total += drained.done;
    if (!drained.more || Date.now() >= deadline) return total;
  }
}
