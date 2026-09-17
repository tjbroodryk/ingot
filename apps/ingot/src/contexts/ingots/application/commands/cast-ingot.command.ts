import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { IngotSummary } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock, ConflictingState } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  Ingot,
  type IngotRepository,
  type IngotTableRepository,
} from '../../domain/index.js';
import { summarise } from '../ingot-summary.js';

export interface CastIngotResult {
  readonly ingot: IngotSummary;
  /** False when `externalId` named an ingot that already existed. */
  readonly created: boolean;
}

/** `POST /api/v1/:account/cast` */
export class CastIngot extends Command<CastIngotResult> {
  constructor(
    readonly accountId: string,
    readonly name: string,
    /** `30m`, `12h`, `14d`, `4w`. Omitted, the ingot is kept indefinitely. */
    readonly retainFor?: string,
    /** The caller's own handle. Given, cast answers with the ingot it already names. */
    readonly externalId?: string,
  ) {
    super();
  }
}

/**
 * Casting an ingot creates nothing but a row.
 *
 * No tables, no bucket prefix, no Parquet. An ingot's shape is decided by what
 * is put into it, and the first `/add` naming a table is what brings that table
 * into existence — so an ingot that is never written to costs one row and
 * nothing else.
 *
 * With an `externalId` it is idempotent, and nothing about an existing ingot
 * is changed by asking for it again — not its name and not its retention, which
 * is what `/config` is for.
 */
@CommandHandler(CastIngot)
export class CastIngotHandler implements ICommandHandler<CastIngot> {
  constructor(
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CastIngot): Promise<CastIngotResult> {
    const now = this.clock.now();
    const ingot = Ingot.cast({
      accountId: command.accountId,
      name: command.name,
      retainFor: command.retainFor,
      externalId: command.externalId,
      now,
    });

    if (ingot.externalId === null) {
      await this.ingots.save(ingot);
      return { ingot: await summarise(ingot, this.tables, this.overlay), created: true };
    }

    const existing = await this.ingots.findByExternalId(command.accountId, ingot.externalId);
    if (existing && !existing.hasExpired(now)) {
      return { ingot: await summarise(existing, this.tables, this.overlay), created: false };
    }
    if (existing) {
      // Past its retention and not reaped yet. The reaper still deletes it;
      // the handle moves to the ingot made here.
      existing.releaseExternalId();
      await this.ingots.save(existing);
    }

    if (await this.ingots.claim(ingot)) {
      return { ingot: await summarise(ingot, this.tables, this.overlay), created: true };
    }

    // Another create with the same handle committed first. Its row is visible
    // now: the conflicting insert waited for that commit before giving up.
    const winner = await this.ingots.findByExternalId(command.accountId, ingot.externalId);
    if (!winner) {
      throw new ConflictingState(
        `an ingot with externalId "${ingot.externalId}" was being created at the same time ` +
          'and did not survive. Try again.',
      );
    }
    return { ingot: await summarise(winner, this.tables, this.overlay), created: false };
  }
}
