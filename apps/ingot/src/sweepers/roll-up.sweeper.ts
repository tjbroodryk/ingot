import { Inject, Logger } from '@nestjs/common';
import type { Context } from '@restatedev/restate-sdk';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../contexts/records/application/ports/overlay-store.port.js';
import { CompactTable } from '../contexts/records/application/commands/compact-table.command.js';
import { RestateCron, RestateHandler, minutes, scheduleNextTick } from '../restate/index.js';
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
 * The reason this is a `@RestateCron` and not `@nestjs/schedule` is the reason
 * `CLAUDE.md` gives: a tick's last act is to book the next one with a
 * journalled, idempotency-keyed self-send, so three replicas collapse into one
 * chain and a pod dying mid-sweep does not end the schedule.
 *
 * It dispatches `CompactTable` rather than compacting inline, which is the
 * same rule the API's sweepers follow — one write path per fact, so a manual
 * compaction and a swept one cannot disagree.
 */
@RestateCron({
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

  @RestateHandler()
  async tick(ctx: Context): Promise<void> {
    const candidates = await ctx.run('tables worth compacting', () =>
      this.overlay.tablesWorthCompacting(MIN_OVERLAY_ROWS, PER_TICK + 1),
    );

    if (candidates.length > PER_TICK) {
      this.logger.log(
        `${candidates.length} tables are over the roll-up threshold; this tick takes ` +
          `${PER_TICK}. The rest go in the next one.`,
      );
    }

    for (const candidate of candidates.slice(0, PER_TICK)) {
      // Each in its own `ctx.run`, so a table that fails is retried on its own
      // rather than replaying the compaction of every table before it.
      await ctx.run(`compact ${candidate.tableId}`, async () => {
        await this.dispatcher.send(new CompactTable(candidate.tableId));
      });
    }

    // Last, always. A tick that throws never reaches this and is retried by
    // Restate instead, so the chain is only ever extended by a pass that
    // finished — and a slow sweep cannot overlap itself.
    await scheduleNextTick(ctx, this);
  }
}
