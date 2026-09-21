import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../shared/application/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import {
  CHANGE_NOTIFIER,
  type ChangeNotifier,
} from '../../../records/application/ports/change-notifier.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import {
  RETIRED_GENERATIONS,
  type RetiredGenerations,
} from '../../../records/application/ports/retired-generations.port.js';
import { ParquetCache } from '../../../../engine/parquet-cache.js';
import { Keys, OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import { INGOT_TABLE_REPOSITORY, type IngotTableRepository } from '../../domain/index.js';
import { IngotAccess } from '../ingot-access.js';

/** `DELETE /api/v1/:account/:ingot/tables/:table` */
export class DropTable extends Command {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly table: string,
  ) {
    super();
  }
}

/**
 * Removes a table entirely — schema, overlay, tombstones, vectors, Parquet.
 *
 * Distinct from forgetting rows because the schema goes too. It is the only
 * way to undo a mapping decision: a column's type cannot change while rows
 * exist under it, so a table declared wrong is dropped and written again.
 */
@CommandHandler(DropTable)
export class DropTableHandler implements ICommandHandler<DropTable> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CHANGE_NOTIFIER) private readonly changes: ChangeNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RETIRED_GENERATIONS) private readonly retired: RetiredGenerations,
    private readonly cache: ParquetCache,
  ) {}

  async execute(command: DropTable): Promise<void> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);
    const table = await this.access.table(command.ingotId, command.accountId, command.table);

    await this.overlay.purgeTable(table.id.value);
    // A table recreated under this name counts generations from one again, and
    // a retirement left behind would delete its files when it fell due.
    await this.retired.purgeTable(table.id.value);
    await this.tables.remove(table.id);
    // The sweeper delivers it; this context has no handle on the worker to wake.
    await this.changes.dropped({
      ingot,
      tableId: table.id.value,
      table: table.name.value,
      at: this.clock.now(),
    });

    // After the commit, for the same reason as DeleteIngot: an orphaned object
    // is cheaper to live with than a manifest pointing at nothing.
    const data = Keys.table(ingot.accountId, ingot.id.value, table.name.value);
    const vectors = `${Keys.ingot(ingot.accountId, ingot.id.value)}/vectors/${table.name.value}`;
    await this.cache.forgetPrefix(data);
    await this.cache.forgetPrefix(vectors);
    this.uow.afterCommit(async () => {
      await this.store.removePrefix(data);
      await this.store.removePrefix(vectors);
    });
  }
}
