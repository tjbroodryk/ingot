/**
 * Background work that can fall behind and needs reconciling. `SWEEPERS` is a
 * `Record` over this enum, so a kind without a ticker fails to compile.
 */
export enum SweptKind {
  RollUp = 'roll_up',
  Embeddings = 'embeddings',
  /** Writes that asked for a summary and have not been given one. */
  Receipts = 'receipts',
  /** Receipts announced to a memory's delivery target and not yet sent. */
  Deliveries = 'deliveries',
  /** Memories past the retention their creator asked for. */
  Expiry = 'expiry',
  /** Documents accepted by `/file` and not yet turned into chunks. */
  Files = 'files',
}
