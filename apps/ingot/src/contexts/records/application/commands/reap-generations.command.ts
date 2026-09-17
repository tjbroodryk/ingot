import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import {
  Command,
  UNIT_OF_WORK,
  type ICommandHandler,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import { RETIRED_GENERATIONS, type RetiredGenerations } from '../ports/retired-generations.port.js';

/** How many retired prefixes one reap removes. The next tick takes the rest. */
const PER_REAP = 100;

/** Deletes replaced Parquet generations whose grace has passed. Returns how many. */
export class ReapGenerations extends Command<number> {}

@CommandHandler(ReapGenerations)
export class ReapGenerationsHandler implements ICommandHandler<ReapGenerations> {
  private readonly logger = new Logger(ReapGenerationsHandler.name);

  constructor(
    @Inject(RETIRED_GENERATIONS) private readonly retired: RetiredGenerations,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<number> {
    const due = await this.retired.takeDue(this.clock.now(), PER_REAP);
    if (due.length === 0) return 0;

    // After the commit, like every other object deletion here. Removing a
    // prefix that is already gone is a no-op, so a crash between the two costs
    // an object that lingers and nothing more.
    this.uow.afterCommit(async () => {
      for (const generation of due) await this.store.removePrefix(generation.prefix);
      this.logger.log(`Reaped ${due.length} replaced Parquet generation prefixes`);
    });
    return due.length;
  }
}
