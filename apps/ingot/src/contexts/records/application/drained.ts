/**
 * What one drain did, and whether the queue outlasted it.
 *
 * The second field is the whole reason this is a shape rather than a count.
 *
 * Every worker here bounds one drain — `PASSES` — so that a large backlog is
 * worked in slices rather than in one run that holds a slot indefinitely. That
 * bound is right, and on its own it was also a throughput ceiling: a drain that
 * stopped with work still queued was not restarted by anything except the next
 * sweep, so a backlog moved at one drain a minute however fast the model
 * answered and however many replicas were running. A single `/add` fanning out
 * into five thousand embeddable rows is one wake, so it got exactly one drain
 * and then waited out the minute for the rest.
 *
 * `more` is what closes that. It says "I stopped because I ran out of passes,
 * not because the queue ran out" — and both callers act on it: `BackgroundWork`
 * books another drain immediately, and a sweeper keeps going within its own
 * tick. The bound stays a yield point, which is what it was always for, rather
 * than a rate limit nobody chose.
 */
export interface Drained {
  /** How much work this drain completed. Rows, receipts or deliveries. */
  readonly done: number;
  /**
   * Whether the pass ran out before the queue did.
   *
   * False also covers "everything left is leased by another worker" and
   * "everything left has run out of attempts", because a drain cannot tell
   * those apart from an empty queue and should not act differently: in all
   * three there is nothing here to gain by going round again.
   */
  readonly more: boolean;
}

/** Nothing was waiting. The common case, and the one that stops a chain. */
export const IDLE: Drained = { done: 0, more: false };
