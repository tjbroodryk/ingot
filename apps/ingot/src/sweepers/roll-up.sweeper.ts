import { Inject, Logger } from '@nestjs/common';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../contexts/records/application/ports/overlay-store.port.js';
import { CompactTable } from '../contexts/records/application/commands/compact-table.command.js';
import { Cron, minutes } from './cron.js';
import { Dispatcher } from '../shared/application/index.js';

const EVERY = minutes(5);

/** How many tables one tick will roll up; a cap so a large backlog is worked in slices. */
const PER_TICK = 25;

/** Overlay depth at which folding into Parquet is worth the rewrite; trades write amplification against read cost. */
const MIN_OVERLAY_ROWS = 1_000;

/**
 * Folds the overlay into the base tier by dispatching `CompactTable`. Needs
 * `Scheduler`'s advisory lock, since `CompactTable` has no mutual exclusion of
 * its own.
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
      // One table failing does not cost the rest of the tick; the next tick retries it.
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
