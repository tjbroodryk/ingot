import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { DeleteBody, DeleteResult } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import {
  Command,
  UNIT_OF_WORK,
  type ICommandHandler,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
} from '../../../../engine/analytical-engine.port.js';
import { SessionBuilder } from '../../../../engine/session-builder.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { BackgroundWork } from '../background.js';
import { CHANGE_NOTIFIER, type ChangeNotifier } from '../ports/change-notifier.port.js';
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
 * Forgetting rows, in a store whose base tier cannot be edited.
 *
 * Parquet is not rewritten in place, so a delete is a tombstone: the predicate
 * is resolved to row ids *now*, against the same union view a query sees, and
 * those ids are recorded. Every read filters them out and the next roll-up
 * drops them for good.
 *
 * Resolving to ids rather than storing the predicate is the decision worth
 * defending. A stored predicate has to be evaluated by every future query, and
 * they accumulate — an ingot deleted from a hundred times would carry a
 * hundred WHERE clauses forever. A set of ids is finite, and it shrinks at the
 * next compaction.
 *
 * It also means "delete" answers a question the caller actually has: how many
 * rows did that match. A predicate applied lazily could not say.
 */
@CommandHandler(DeleteRecords)
export class DeleteRecordsHandler implements ICommandHandler<DeleteRecords> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(ANALYTICAL_ENGINE) private readonly engine: AnalyticalEngine,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CHANGE_NOTIFIER) private readonly changes: ChangeNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly sessions: SessionBuilder,
    private readonly background: BackgroundWork,
  ) {}

  async execute(command: DeleteRecords): Promise<DeleteResult> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);
    const table = await this.access.table(command.ingotId, command.accountId, command.body.table);

    const resolved = await this.engine.resolveRows({
      table: await this.sessions.materialisable(table),
      where: command.body.where,
      cap: MAX_FORGOTTEN_PER_CALL,
      timeoutMs: RESOLVE_TIMEOUT_MS,
    });

    const now = this.clock.now();
    await this.overlay.forget(table.id.value, resolved.rowIds, now);

    if (resolved.rowIds.length > 0) {
      const announced = await this.changes.appended({
        ingot,
        tableId: table.id.value,
        table: table.name.value,
        generation: table.generation,
        throughSeq: async () => null,
        rows: 0,
        tombstones: resolved.rowIds.length,
        at: now,
      });
      if (announced) this.uow.afterCommit(() => this.background.wakeDeliveries());
    }

    return {
      table: table.name.value,
      rowsForgotten: resolved.rowIds.length,
      // Said rather than silently capped: "50000 rows forgotten" reads as
      // "that is all of them" unless something says otherwise.
      truncated: resolved.truncated,
    };
  }
}
