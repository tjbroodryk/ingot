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
import { FILE_QUEUE, type FileQueue } from '../../../files/application/ports/file-queue.port.js';
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
 * Destroys a memory: manifest, overlay, queued work, and every object under it.
 *
 * The list is the interesting part rather than the mechanism. Anything keyed on
 * an ingot and *not* purged here outlives the memory silently — nothing else
 * visits those rows, so there is no later moment at which the omission shows up.
 * `file_queue` was exactly that for a while: destroying a memory left a row
 * holding a filename, a hash, an extraction mapping and an error message
 * quoting the document, pointing at an object that had already been removed.
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
    @Inject(FILE_QUEUE) private readonly files: FileQueue,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(command: DeleteIngot): Promise<void> {
    const ingot = await this.access.ingot(command.ingotId, command.accountId);

    await this.overlay.purgeIngot(ingot.id.value);
    // Announcements go with the memory. Delivering one afterwards would hand a
    // receiver a query that can only ever come back empty.
    await this.outbox.purgeIngot(ingot.id.value);
    /*
     * And unparsed uploads, which is the one that leaks if it is forgotten.
     *
     * A queue row outlives its memory in a way an overlay row cannot: nothing
     * else ever visits it. It holds the filename, the sha256, the caller's
     * extraction mapping and `last_error` — and that last field quotes the value
     * that failed to coerce, so it can carry a fragment of the document itself.
     * Leaving one behind means "destroy this memory" quietly kept content
     * derived from it, for ever, pointing at an object that is already gone.
     */
    await this.files.purgeIngot(ingot.id.value);
    await this.ingots.remove(ingot.id);

    const prefix = Keys.ingot(ingot.accountId, ingot.id.value);
    this.uow.afterCommit(() => this.store.removePrefix(prefix));
  }
}
