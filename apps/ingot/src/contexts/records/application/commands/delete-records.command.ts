import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { DeleteBody, DeleteResult } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
} from '../../../../engine/analytical-engine.port.js';
import { SessionBuilder } from '../../../../engine/session-builder.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

/** How many rows one `/delete` may forget. Run it again for more. */
export const MAX_FORGOTTEN_PER_CALL = 50_000;
const RESOLVE_TIMEOUT_MS = 15_000;

/** `POST /api/v1/:account/:ingot/delete` */
export class DeleteRecords extends Command<DeleteResult> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly body: DeleteBody,
  ) {
    super();
  }
}

/**
 * Forgetting rows in a store whose base tier cannot be edited: the predicate is
 * resolved to row ids now, against the union view a query sees, and recorded as
 * tombstones. Reads filter them out and the next roll-up drops them for good.
 */
@CommandHandler(DeleteRecords)
export class DeleteRecordsHandler implements ICommandHandler<DeleteRecords> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(ANALYTICAL_ENGINE) private readonly engine: AnalyticalEngine,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sessions: SessionBuilder,
  ) {}

  async execute(command: DeleteRecords): Promise<DeleteResult> {
    const table = await this.access.table(command.ingotId, command.accountId, command.body.table);

    const resolved = await this.engine.resolveRows({
      table: await this.sessions.materialisable(table),
      where: command.body.where,
      cap: MAX_FORGOTTEN_PER_CALL,
      timeoutMs: RESOLVE_TIMEOUT_MS,
    });

    await this.overlay.forget(table.id.value, resolved.rowIds, this.clock.now());

    return {
      table: table.name.value,
      rowsForgotten: resolved.rowIds.length,
      // Reported so a capped result is not mistaken for the whole match.
      truncated: resolved.truncated,
    };
  }
}
