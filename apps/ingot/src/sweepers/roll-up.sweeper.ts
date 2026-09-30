import { Inject, Logger } from '@nestjs/common';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../contexts/records/application/ports/overlay-store.port.js';
import { CompactTable } from '../contexts/records/application/commands/compact-table.command.js';
import type { Drained } from '../contexts/records/application/drained.js';
import { ReapGenerations } from '../contexts/records/application/commands/reap-generations.command.js';
import {
  ROLL_UP_SETTINGS,
  type RollUpSettings,
} from '../contexts/records/application/roll-up-settings.js';
import { ParquetCache } from '../engine/parquet-cache.js';
import { CLOCK, type Clock } from '../shared/domain/index.js';
import { Cron, minutes, seconds } from './cron.js';
import { drainWithin } from './drain-within.js';
import { Dispatcher } from '../shared/application/index.js';

/** Near-constant: a table that falls due waits at most this long to be seen. */
const EVERY = seconds(5);

/**
 * How long one tick keeps taking batches while tables are still due. Under the
 * scheduler's overrun warning, so a busy tick is not reported as a stuck one.
 */
const RUN_FOR = seconds(10);

/** Tables taken per batch. `INGOT_ROLLUP_CONCURRENCY` of them compact at once. */
const BATCH = 25;

/** How long a table whose roll-up failed waits before it is tried again. */
const RETRY_AFTER = minutes(1);

/**
 * How often the rest runs: deleting replaced generations, sweeping the Parquet
 * cache, and scheduling any table a racing write left unscheduled.
 */
const HOUSEKEEPING_EVERY = minutes(5);

/**
 * Rolls up the tables `roll_up_due` says are due.
 *
 * A write schedules its table `INGOT_ROLLUP_INTERVAL_MS` ahead, or for now once
 * the overlay reaches `INGOT_ROLLUP_MIN_ROWS`. This takes due tables in
 * batches, compacts `INGOT_ROLLUP_CONCURRENCY` of each batch at a time, and
 * goes straight on to the next batch until nothing is due.
 *
 * Exclusive, and the lock is why. `CompactTable` has no mutual exclusion of
 * its own: two replicas rolling the same table up would both compute
 * `generation + 1`, write to the same keys and both flip the manifest. Within
 * one replica a batch never holds the same table twice.
 *
 * A tick that dies part-way loses nothing: a table's schedule is only rewritten
 * by the compaction that consumed it, in the same transaction.
 */
@Cron({
  name: 'roll-up-ingots',
  everyMs: EVERY,
  exclusive: true,
  description: 'Rolls overlay rows up into new Parquet generations',
})
export class RollUpSweeper {
  private readonly logger = new Logger(RollUpSweeper.name);
  private housekeptAt = 0;

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    private readonly cache: ParquetCache,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROLL_UP_SETTINGS) private readonly settings: RollUpSettings,
  ) {}

  async tick(): Promise<void> {
    await drainWithin(RUN_FOR, () => this.batch());

    const now = this.clock.now().getTime();
    if (now - this.housekeptAt >= HOUSEKEEPING_EVERY) {
      this.housekeptAt = now;
      await this.housekeep();
    }
  }

  /** One batch of due tables, compacted `concurrency` at a time. */
  async batch(): Promise<Drained> {
    const due = await this.overlay.dueForRollUp(this.clock.now(), BATCH);
    const queue = [...due];
    let done = 0;

    const worker = async (): Promise<void> => {
      for (let tableId = queue.shift(); tableId; tableId = queue.shift()) {
        if (await this.rollUp(tableId)) done += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.settings.concurrency, due.length) }, worker),
    );

    return { done, more: due.length === BATCH };
  }

  private async rollUp(tableId: string): Promise<boolean> {
    try {
      await this.dispatcher.send(new CompactTable(tableId));
      return true;
    } catch (error) {
      // Pushed back rather than left due, or the next batch would take it
      // straight back and a broken table would spin.
      this.logger.error(
        `Rolling up ${tableId} failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Trying again in ${RETRY_AFTER / 60_000} minute(s).`,
      );
      await this.overlay
        .postponeRollUp(tableId, new Date(this.clock.now().getTime() + RETRY_AFTER))
        .catch(() => {});
      return false;
    }
  }

  private async housekeep(): Promise<void> {
    try {
      const found = await this.overlay.scheduleUnscheduled();
      if (found > 0) {
        this.logger.warn(
          `${found} table(s) had overlay rows and no roll-up scheduled; scheduled them now.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Scheduling unscheduled roll-ups failed: ` +
          `${error instanceof Error ? error.message : String(error)}. The next pass tries again.`,
      );
    }

    // Under this lock because it deletes what a roll-up retired.
    try {
      await this.dispatcher.send(new ReapGenerations());
    } catch (error) {
      this.logger.error(
        `Reaping replaced generations failed: ` +
          `${error instanceof Error ? error.message : String(error)}. The next pass tries again.`,
      );
    }

    // Also here for the lock: every replica shares the cache, and two sweeps
    // deciding what to evict at once would each count the other's deletes.
    try {
      await this.cache.sweep();
    } catch (error) {
      this.logger.error(
        `Sweeping the Parquet cache failed: ` +
          `${error instanceof Error ? error.message : String(error)}. The next pass tries again.`,
      );
    }
  }
}
