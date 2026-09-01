import { Inject, Logger } from '@nestjs/common';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../contexts/records/application/ports/overlay-store.port.js';
import { CompactTable } from '../contexts/records/application/commands/compact-table.command.js';
import { Cron, minutes } from './cron.js';
import { Dispatcher } from '../shared/application/index.js';

const EVERY = minutes(5);

/**
 * How many tables one tick will roll up.
 *
 * A cap rather than everything, because a compaction rewrites a whole table
 * and a service with a thousand busy tables would spend a tick on the first
 * hundred either way. The bound is announced rather than silent, per
 * `CLAUDE.md` — a sweep that quietly did a tenth of the work reads exactly
 * like one that had nothing to do.
 */
const PER_TICK = 25;

/**
 * How deep an overlay has to get before it is worth rewriting Parquet.
 *
 * Too low and every tick rewrites a whole table to fold in three rows. Too
 * high and queries carry a large overlay through every session. This is the
 * knob that trades write amplification against read cost.
 */
const MIN_OVERLAY_ROWS = 1_000;

/**
 * Folds the overlay into the base tier.
 *
 * This is the sweeper that needs `Scheduler`'s advisory lock, and the reason it
 * exists. `CompactTable` has no mutual exclusion of its own: two replicas
 * rolling the same table up would both compute `generation + 1`, write to the
 * same keys and both flip the manifest. One replica at a time is what makes
 * that impossible, and it is the only guarantee here that a second pod could
 * break.
 *
 * A tick that dies part-way is simply run again from the top on the next turn.
 * That costs a repeated listing and nothing else: a table whose manifest
 * already flipped has no watermark left to fold and `CompactTable` returns
 * `null` for it.
 *
 * It dispatches `CompactTable` rather than compacting inline, which is the
 * same rule the API's sweepers follow — one write path per fact, so a manual
 * compaction and a swept one cannot disagree.
 */
@Cron({
  name: 'roll-up-ingots',
  everyMs: EVERY,
  description: 'Rolls overlay rows up into new Parquet generations',
})
export class RollUpSweeper {
  private readonly logger = new Logger(RollUpSweeper.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
  ) {}

  async tick(): Promise<void> {
    const candidates = await this.overlay.tablesWorthCompacting(MIN_OVERLAY_ROWS, PER_TICK + 1);

    if (candidates.length > PER_TICK) {
      this.logger.log(
        `${candidates.length} tables are over the roll-up threshold; this tick takes ` +
          `${PER_TICK}. The rest go in the next one.`,
      );
    }

    for (const candidate of candidates.slice(0, PER_TICK)) {
      /*
       * One table failing does not cost the rest of the tick.
       *
       * Restate used to give each its own journalled step, so a retry resumed
       * at the one that failed. Without a journal the equivalent is to keep
       * going and let the next tick find whatever did not compact — which is
       * the better shape anyway: a single unhealthy table used to stall every
       * table behind it in the same pass.
       */
      try {
        await this.dispatcher.send(new CompactTable(candidate.tableId));
      } catch (error) {
        this.logger.error(
          `Rolling up ${candidate.tableId} failed: ` +
            `${error instanceof Error ? error.message : String(error)}. The next tick tries again.`,
        );
      }
    }
  }
}
