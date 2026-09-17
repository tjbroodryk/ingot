import type { Ingot } from '../../../ingots/domain/index.js';

/**
 * Tells an ingot's delivery target that a table changed.
 *
 * Called **inside the transaction that made the change**, like
 * `ReceiptNotifier`, so an announcement exists exactly when the change does.
 * Each call is a no-op for an ingot whose strategy does not ask for the event,
 * which is every ingot that has not named it in `events`.
 *
 * The ingot is passed in rather than looked up: every caller has just loaded
 * it to check the tenancy, and its delivery strategy is what decides whether
 * there is anything to do. Each method says whether it announced anything, so
 * the caller knows whether to wake the delivery worker after the commit.
 */
export interface ChangeNotifier {
  /** Rows stored (`rows`) or forgotten (`tombstones`) in one table. */
  appended(change: {
    ingot: Ingot;
    tableId: string;
    table: string;
    generation: number;
    /** The overlay's highest `seq` after the write. Null when it wrote no rows. */
    throughSeq: () => Promise<bigint | null>;
    rows: number;
    tombstones: number;
    at: Date;
  }): Promise<boolean>;

  rolledUp(change: {
    ingot: Ingot;
    tableId: string;
    table: string;
    generation: number;
    rows: number;
    at: Date;
  }): Promise<boolean>;

  dropped(change: { ingot: Ingot; tableId: string; table: string; at: Date }): Promise<boolean>;
}

export const CHANGE_NOTIFIER = Symbol('ChangeNotifier');
