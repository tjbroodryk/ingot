import { randomUUID } from 'node:crypto';
import { Inject, Logger } from '@nestjs/common';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type RollUpClaim,
} from '../contexts/records/application/ports/overlay-store.port.js';
import { type HeldClaim, TableRollUp } from '../contexts/records/application/table-roll-up.js';
import type { Drained } from '../contexts/records/application/drained.js';
import { ReapGenerations } from '../contexts/records/application/commands/reap-generations.command.js';
import {
  ROLL_UP_SETTINGS,
  type RollUpSettings,
} from '../contexts/records/application/roll-up-settings.js';
import { ParquetCache } from '../engine/parquet-cache.js';
import { Metrics } from '../observability/index.js';
import { CLOCK, type Clock } from '../shared/domain/index.js';
import { Cron, minutes, seconds } from './cron.js';
import { drainWithin } from './drain-within.js';
import { ExclusiveWork } from './exclusive.js';
import { Dispatcher } from '../shared/application/index.js';

/** Near-constant: a table that falls due waits at most this long to be seen. */
const EVERY = seconds(5);

/**
 * How long one tick keeps taking batches while tables are still due. Under the
 * scheduler's overrun warning, so a busy tick is not reported as a stuck one.
 */
const RUN_FOR = seconds(10);

/** Tables claimed per batch. `INGOT_ROLLUP_CONCURRENCY` of them compact at once. */
const BATCH = 25;

/** How long a table whose roll-up failed waits before it is tried again. */
const RETRY_AFTER = minutes(1);

/**
 * How long a claim holds a table without being renewed. Long against a
 * roll-up, which takes about a second: it only lapses for a worker that died
 * or stalled, and another worker then takes the table.
 */
const LEASE = minutes(5);

/** How often a batch renews the claims it still holds. */
const RENEW_EVERY = minutes(1);

/**
 * How often the rest runs: deleting replaced generations, sweeping the Parquet
 * cache, and scheduling any table a racing write left unscheduled.
 */
const HOUSEKEEPING_EVERY = minutes(5);

/**
 * Rolls up the tables `roll_up_due` says are due, on every replica.
 *
 * A write schedules its table `INGOT_ROLLUP_INTERVAL_MS` ahead, or for now once
 * the overlay reaches `INGOT_ROLLUP_MIN_ROWS`. Each tick claims due tables in
 * batches, compacts `INGOT_ROLLUP_CONCURRENCY` of each batch at a time, and
 * goes straight on to the next batch until nothing is due. More replicas is
 * more roll-ups at once: they claim different tables.
 *
 * `TableRollUp` has no mutual exclusion of its own — two workers on one table
 * would both compute `generation + 1`, write the same keys and both flip the
 * manifest. The claim is what prevents that. A worker holds each table under a
 * token and a lease it renews while it works; it re-checks the claim before it
 * uploads, and `PublishRollUp` publishes only while the token is still on the
 * row. A worker that stalls past its lease loses the table and publishes
 * nothing.
 *
 * Housekeeping still runs one replica at a time, under a lock of its own.
 */
@Cron({
  name: 'roll-up-ingots',
  everyMs: EVERY,
  // The claims do what the lock did, per table rather than for everything.
  exclusive: false,
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
    private readonly tableRollUp: TableRollUp,
    private readonly exclusive: ExclusiveWork,
  ) {}

  async tick(): Promise<void> {
    await drainWithin(RUN_FOR, () => this.batch());

    const now = this.clock.now().getTime();
    if (now - this.housekeptAt >= HOUSEKEEPING_EVERY) {
      this.housekeptAt = now;
      await this.exclusive.attempt('roll-up-housekeeping', () => this.housekeep());
    }
  }

  /** One batch of claimed tables, compacted `concurrency` at a time. */
  async batch(): Promise<Drained> {
    const token = randomUUID();
    const claimed = await this.overlay.claimRollUps(this.clock.now(), BATCH, this.lease(token));
    if (claimed.length === 0) return { done: 0, more: false };

    const held = new Set(claimed);
    const renewing = setInterval(() => {
      void this.overlay
        .renewRollUpClaims([...held], this.lease(token))
        .catch((error: unknown) => this.logger.warn(`Renewing roll-up claims failed: ${error}`));
    }, RENEW_EVERY);
    renewing.unref?.();

    const queue = [...claimed];
    let done = 0;
    const worker = async (): Promise<void> => {
      for (let tableId = queue.shift(); tableId; tableId = queue.shift()) {
        if (await this.rollUp(tableId, this.hold(tableId, token))) done += 1;
        held.delete(tableId);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.settings.concurrency, claimed.length) }, worker),
      );
    } finally {
      clearInterval(renewing);
    }

    return { done, more: claimed.length === BATCH };
  }

  private lease(token: string): RollUpClaim {
    return { token, until: new Date(this.clock.now().getTime() + LEASE) };
  }

  private hold(tableId: string, token: string): HeldClaim {
    return {
      token,
      confirm: async () => {
        const renewed = await this.overlay.renewRollUpClaims([tableId], this.lease(token));
        if (!renewed.includes(tableId)) {
          throw new Error(`the claim on ${tableId} lapsed and another worker took it`);
        }
      },
    };
  }

  private async rollUp(tableId: string, claim: HeldClaim): Promise<boolean> {
    try {
      await this.tableRollUp.run(tableId, claim);
      return true;
    } catch (error) {
      // Pushed back rather than left due, or the next batch would take it
      // straight back and a broken table would spin. Only while this batch
      // still holds it: a table another worker took is that worker's.
      this.logger.error(
        `Rolling up ${tableId} failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Trying again in ${RETRY_AFTER / 60_000} minute(s).`,
      );
      await this.overlay
        .postponeRollUp(tableId, new Date(this.clock.now().getTime() + RETRY_AFTER), claim.token)
        .catch(() => {});
      return false;
    }
  }

  private async housekeep(): Promise<void> {
    try {
      const found = await this.overlay.scheduleUnscheduled();
      Metrics.RollUpsUnscheduledFound.inc({}, found);
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
