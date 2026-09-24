import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingEmbedding,
} from '../ports/overlay-store.port.js';

/**
 * Puts a claimed batch back, unembedded. No attempt counter: embedding is cheap
 * to retry and a text left queued fills in late, whereas one given up on stays
 * empty. Releasing the lease returns the batch before it would expire.
 */
export class ReleaseEmbeddings extends Command<void> {
  constructor(readonly entries: readonly PendingEmbedding[]) {
    super();
  }
}

@CommandHandler(ReleaseEmbeddings)
export class ReleaseEmbeddingsHandler implements ICommandHandler<ReleaseEmbeddings> {
  constructor(@Inject(OVERLAY_STORE) private readonly overlay: OverlayStore) {}

  execute(command: ReleaseEmbeddings): Promise<void> {
    return this.overlay.releasePending(command.entries);
  }
}
