import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { ConflictingState } from '../../../../shared/domain/index.js';
import {
  type EmbeddingSpace,
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  IngotId,
  IngotTableId,
  type IngotRepository,
  type IngotTableRepository,
} from '../../../ingots/domain/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingEmbedding,
} from '../ports/overlay-store.port.js';

/** One text and the vector a model returned for it. */
export interface EmbeddedText extends PendingEmbedding {
  readonly vector: readonly number[];
}

/**
 * Stores vectors a model has already produced.
 *
 * The second half of the split, and short by construction: the embedder was
 * called outside any transaction, so all this does is claim the memory's
 * vector space, upsert the vectors, and take their rows out of the queue.
 * Leaving the queue is what marks a row done, and it happens in the same
 * transaction as the vector — so a crash between the two leaves the row queued
 * and it is simply embedded again.
 */
export class SaveEmbeddings extends Command<number> {
  constructor(
    readonly embedded: readonly EmbeddedText[],
    readonly space: EmbeddingSpace,
  ) {
    super();
  }
}

@CommandHandler(SaveEmbeddings)
export class SaveEmbeddingsHandler implements ICommandHandler<SaveEmbeddings> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
  ) {}

  async execute(command: SaveEmbeddings): Promise<number> {
    if (command.embedded.length === 0) return 0;

    // Before the vectors, not after. If the memory is already embedded with a
    // different model this throws, the transaction rolls back, and nothing is
    // written — which is the whole point. Writing first and checking after
    // would leave exactly the mixture the check exists to prevent.
    for (const ingotId of await this.ingotsFor(command.embedded)) {
      await this.claimSpace(ingotId, command.space);
    }

    await this.overlay.saveVectors(command.embedded, command.space.model);
    return command.embedded.length;
  }

  /**
   * Which memories this batch touches.
   *
   * A claim takes the oldest queued texts across every table, so one batch can
   * span several memories. Resolved through the tables rather than carried on
   * the queue row: it is a primary-key read per distinct table in the batch,
   * against a batch of up to 128 rows that usually belong to one or two.
   */
  private async ingotsFor(embedded: readonly EmbeddedText[]): Promise<Set<string>> {
    const ingotIds = new Set<string>();

    for (const tableId of new Set(embedded.map((entry) => entry.tableId))) {
      const table = await this.tables.findById(IngotTableId.of(tableId));
      if (table) ingotIds.add(table.ingotId);
    }
    return ingotIds;
  }

  /**
   * Records the vector space, or holds this write to the one already there.
   *
   * Only writes when something changed, which matters more than it looks: the
   * steady state is a memory whose space was claimed by its first batch, and
   * saving unconditionally would make every later batch contend on the
   * memory's version for nothing.
   *
   * Two first batches racing is the one case that writes twice, and the loser
   * re-reads rather than failing — the winner recorded the same model, since
   * both got it from the same configured embedder.
   */
  private async claimSpace(ingotId: string, space: EmbeddingSpace): Promise<void> {
    const ingot = await this.ingots.findById(IngotId.of(ingotId));
    // A memory deleted between the claim and now. Its rows are going with it.
    if (!ingot) return;

    const claimed = ingot.embedding !== null;
    // Throws when this batch's model disagrees with the one on record, which
    // is the refusal the whole feature exists for.
    ingot.useEmbedding(space);
    if (claimed) return;

    try {
      await this.ingots.save(ingot);
    } catch (error) {
      if (!(error instanceof ConflictingState)) throw error;

      const winner = await this.ingots.findById(IngotId.of(ingotId));
      // Whoever won recorded a space; if it disagrees with ours this throws,
      // which is the same refusal by a different route.
      winner?.assertEmbeddingMatches(space);
    }
  }
}
