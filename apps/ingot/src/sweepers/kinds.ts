/**
 * What can fall behind in this service.
 *
 * Unlike `@forge/api`, none of these mirror somebody else's system — an ingot
 * holds only what was posted to it. What they reconcile is our own background
 * work: the roll-up that has not caught up, the embedding that has not run.
 * The failure mode is the same shape, though, and so is the fix: a delivery is
 * the fast path and a sweep is the floor.
 *
 * `SWEEPERS` is a `Record` over this enum, so adding a kind without a ticker
 * fails to compile.
 */
export enum SweptKind {
  RollUp = 'roll_up',
  Embeddings = 'embeddings',
  /** Writes that asked for a summary and have not been given one. */
  Receipts = 'receipts',
  /** Memories past the retention their creator asked for. */
  Expiry = 'expiry',
}
