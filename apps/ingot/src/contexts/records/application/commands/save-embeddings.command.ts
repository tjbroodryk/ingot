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
 * Stores vectors a model has already produced. The embedder was called outside
 * any transaction, so this just claims the memory's vector space, upserts the
 * vectors, and takes their rows out of the queue, all in one transaction.
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

    // Before the vectors: if the memory is already embedded with a different
    // model this throws and the transaction rolls back, so the mixture the
    // check prevents is never written.
    for (const ingotId of await this.ingotsFor(command.embedded)) {
      await this.claimSpace(ingotId, command.space);
    }

    await this.overlay.saveVectors(command.embedded, command.space.model);
    return command.embedded.length;
  }

  /**
   * Which memories this batch touches. A claim takes the oldest queued texts
   * across every table, so one batch can span several memories.
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
   * Only writes when something changed, so later batches do not contend on the
   * memory's version. Two racing first batches both record the same model.
   */
  private async claimSpace(ingotId: string, space: EmbeddingSpace): Promise<void> {
    const ingot = await this.ingots.findById(IngotId.of(ingotId));
    // Memory deleted between the claim and now; its rows go with it.
    if (!ingot) return;

    const claimed = ingot.embedding !== null;
    // Throws when this batch's model disagrees with the one on record.
    ingot.useEmbedding(space);
    if (claimed) return;

    try {
      await this.ingots.save(ingot);
    } catch (error) {
      if (!(error instanceof ConflictingState)) throw error;

      const winner = await this.ingots.findById(IngotId.of(ingotId));
      // If the winner recorded a different model, this throws — the same
      // refusal by another route.
      winner?.assertEmbeddingMatches(space);
    }
  }
}
