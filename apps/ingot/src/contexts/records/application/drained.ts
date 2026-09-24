/**
 * What one drain did, and whether the queue outlasted it. `more` says the drain
 * stopped on its pass bound (`PASSES`), not an empty queue, so a caller can
 * start another immediately rather than waiting for the next sweep.
 */
export interface Drained {
  /** How much work this drain completed. Rows, receipts or deliveries. */
  readonly done: number;
  /**
   * Whether the pass ran out before the queue did. False also covers "all
   * leased" and "all out of attempts": a drain cannot tell those from empty and
   * gains nothing by going round again.
   */
  readonly more: boolean;
}

/** Nothing was waiting. The common case, and the one that stops a chain. */
export const IDLE: Drained = { done: 0, more: false };
