import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../shared/application/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  DELIVERY_OUTBOX,
  type DeliveryOutbox,
} from '../../../records/application/ports/delivery-outbox.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import { Keys, OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import { INGOT_REPOSITORY, type IngotRepository } from '../../domain/index.js';
import { IngotAccess } from '../ingot-access.js';

/** `DELETE /api/v1/:account/:ingot` */
export class DeleteIngot extends Command {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
  ) {
    super();
  }
}

/**
 * Destroys a memory: manifest, overlay, and every Parquet object under it.
 *
 * The bucket is emptied *after* the transaction commits, not inside it. An
 * object store has no rollback, so deleting first and then failing to commit
 * would leave a manifest pointing at files that are gone — a memory that
 * appears in `/info` and fails on every query. Committing first and then
 * failing to empty the bucket leaves orphaned objects instead, which cost
 * money and nothing else, and which the generation reaper picks up.
 *
 * Of the two ways to be wrong, that is the one to choose.
 */
@CommandHandler(DeleteIngot)
export class DeleteIngotHandler implements ICommandHandler<DeleteIngot> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(command: DeleteIngot): Promise<void> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);

    await this.overlay.purgeIngot(ingot.id.value);
    // Announcements go with the memory. Delivering one afterwards would hand a
    // receiver a query that can only ever come back empty.
    await this.outbox.purgeIngot(ingot.id.value);
    await this.ingots.remove(ingot.id);

    const prefix = Keys.ingot(ingot.accountId, ingot.id.value);
    this.uow.afterCommit(() => this.store.removePrefix(prefix));
  }
}
