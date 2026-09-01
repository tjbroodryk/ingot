import { Inject, Logger } from '@nestjs/common';
import type { Context } from '@restatedev/restate-sdk';
import { DeleteIngot } from '../contexts/ingots/application/commands/delete-ingot.command.js';
import { CLOCK, type Clock } from '../shared/domain/index.js';
import {
  INGOT_REPOSITORY,
  IngotId,
  type IngotRepository,
} from '../contexts/ingots/domain/index.js';
import { RestateCron, RestateHandler, minutes, scheduleNextTick } from '../restate/index.js';
import { Dispatcher } from '../shared/application/index.js';

const EVERY = minutes(10);

/**
 * How many memories one tick will destroy.
 *
 * Low on purpose. This is the only thing in the service that deletes data
 * nobody asked it to delete right now, and a bug here is not a slow queue — it
 * is somebody's memory, gone. A small cap means a mistake is small and visible
 * for several ticks before it is large, and the log line below is what makes
 * it visible.
 */
const PER_TICK = 25;

/**
 * Deletes memories past their retention.
 *
 * A caller who said `retainFor: '14d'` at creation gets exactly that, and this
 * is what makes the promise true. Everything else in the service only deletes
 * when told to.
 *
 * It dispatches the ordinary `DeleteIngot` — the same command the endpoint
 * uses, with the same tenancy check and the same after-commit bucket cleanup —
 * rather than a second deletion path. One write path per fact, so reaping is
 * "the thing the caller could have done themselves, done on time".
 */
@RestateCron({
  name: 'reap-expired-ingots',
  everyMs: EVERY,
  description: 'Deletes memories whose retention has run out',
})
export class ExpirySweeper {
  private readonly logger = new Logger(ExpirySweeper.name);

  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @RestateHandler()
  async tick(ctx: Context): Promise<void> {
    const due = await ctx.run('memories past their retention', () =>
      this.ingots.listExpired(this.clock.now(), PER_TICK + 1),
    );

    if (due.length === 0) {
      // Silent when nothing moved. A ten-minute job over a service where
      // nothing expires should not produce a line every ten minutes.
      await scheduleNextTick(ctx, this);
      return;
    }

    if (due.length > PER_TICK) {
      this.logger.log(
        `${due.length} memories are past their retention; this tick takes ${PER_TICK}. ` +
          'The rest go in the next one.',
      );
    }

    for (const target of due.slice(0, PER_TICK)) {
      await ctx.run(`reap ${target.id}`, async () => {
        /*
         * Read again, and check again, immediately before deleting.
         *
         * The listing already filtered on `expires_at <= now` in SQL, so this
         * is belt and braces — and it is worth having precisely because the
         * thing on the other side is irreversible. It costs one indexed read
         * per memory at a cap of twenty-five, and it means the decision to
         * destroy something is made against the row as it is now rather than
         * as it was when a query ran.
         */
        const ingot = await this.ingots.findById(IngotId.of(target.id));
        if (!ingot) return; // Already gone; somebody deleted it themselves.

        if (!ingot.hasExpired(this.clock.now())) {
          this.logger.warn(`"${target.name}" was listed as expired but is not — leaving it alone`);
          return;
        }

        await this.dispatcher.send(new DeleteIngot(target.id, target.accountId));
        // Loud, and one line per memory. Deleting somebody's data is not a
        // thing to do quietly, and this is the only record that it happened.
        this.logger.log(`Reaped "${target.name}" (${target.id}): retention ran out`);
      });
    }

    await scheduleNextTick(ctx, this);
  }
}
