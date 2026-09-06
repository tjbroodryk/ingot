import type { Drained } from '../contexts/records/application/drained.js';

/**
 * Runs a worker's drain until the queue is empty or this tick's time is up.
 *
 * The three queue sweepers all want the same thing and it is not one drain.
 * Each worker bounds a single drain with `PASSES`, so that a backlog is worked
 * in slices rather than in one run that holds a slot indefinitely — and a
 * sweeper that called `drain` once turned that yield point into a rate limit:
 * a backlog moved at one drain per tick, however fast the model answered and
 * however many replicas were running.
 *
 * `Drained.more` is the worker saying it stopped on its own bound rather than
 * on an empty queue, and this is the loop that acts on it.
 *
 * **The deadline is what keeps a tick a tick.** Without one, a sweeper handed a
 * large enough backlog runs until it is gone — which is right for the work and
 * wrong for everything else: `Scheduler.onModuleDestroy` waits for a turn in
 * flight, so a shutdown would wait with it, and the advisory lock would be held
 * by one replica for the whole time. One interval is the natural bound: a tick
 * never runs past the moment the next one would have started, and what it did
 * not finish is the next tick's, which is the arrangement a sweeper already
 * has with itself.
 *
 * It is checked between drains rather than inside one, so a tick overruns by at
 * most a single drain. That is deliberate — a drain interrupted half way would
 * leave a claim leased with nobody working it, waiting out the lease for no
 * reason.
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
