import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { IngotSummary } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { INGOT_REPOSITORY, Ingot, type IngotRepository } from '../../domain/index.js';

/** `POST /api/v1/:account/create` */
export class CreateIngot extends Command<IngotSummary> {
  constructor(
    readonly accountId: string,
    readonly name: string,
    /** `30m`, `12h`, `14d`, `4w`. Omitted, the memory is kept indefinitely. */
    readonly retainFor?: string,
  ) {
    super();
  }
}

/**
 * Casting an ingot creates nothing but a row.
 *
 * No tables, no bucket prefix, no Parquet. A memory's shape is decided by what
 * is put into it, and the first `/add` naming a table is what brings that table
 * into existence — so an ingot that is never written to costs one row and
 * nothing else.
 */
@CommandHandler(CreateIngot)
export class CreateIngotHandler implements ICommandHandler<CreateIngot> {
  constructor(
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreateIngot): Promise<IngotSummary> {
    const ingot = Ingot.cast({
      accountId: command.accountId,
      name: command.name,
      retainFor: command.retainFor,
      now: this.clock.now(),
    });
    await this.ingots.save(ingot);
    return {
      id: ingot.id.value,
      name: ingot.name,
      tables: 0,
      rows: 0,
      createdAt: ingot.createdAt.toISOString(),
      expiresAt: ingot.expiresAt?.toISOString() ?? null,
    };
  }
}
