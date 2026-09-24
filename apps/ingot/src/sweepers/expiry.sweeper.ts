import { Inject, Logger } from '@nestjs/common';
import { DeleteIngot } from '../contexts/ingots/application/commands/delete-ingot.command.js';
import { CLOCK, type Clock } from '../shared/domain/index.js';
import {
  INGOT_REPOSITORY,
  IngotId,
  type IngotRepository,
} from '../contexts/ingots/domain/index.js';
import { Cron, minutes } from './cron.js';
import { Dispatcher } from '../shared/application/index.js';

const EVERY = minutes(10);

/** How many memories one tick will destroy; kept low so a bug stays small and visible. */
const PER_TICK = 25;

/** Deletes memories past their retention by dispatching the ordinary `DeleteIngot`. */
@Cron({
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

  async tick(): Promise<void> {
    const due = await this.ingots.listExpired(this.clock.now(), PER_TICK + 1);

    // Silent when nothing is due.
    if (due.length === 0) return;

    if (due.length > PER_TICK) {
      this.logger.log(
        `${due.length} memories are past their retention; this tick takes ${PER_TICK}. ` +
          'The rest go in the next one.',
      );
    }

    for (const target of due.slice(0, PER_TICK)) {
      // Re-read and re-check immediately before deleting, since the delete is
      // irreversible and the listing ran earlier.
      const ingot = await this.ingots.findById(IngotId.of(target.id));
      if (!ingot) continue; // Already deleted.

      if (!ingot.hasExpired(this.clock.now())) {
        this.logger.warn(`"${target.name}" was listed as expired but is not — leaving it alone`);
        continue;
      }

      await this.dispatcher.send(new DeleteIngot(target.id, target.accountId));
      // One line per memory: the only record that a reap happened.
      this.logger.log(`Reaped "${target.name}" (${target.id}): retention ran out`);
    }
  }
}
