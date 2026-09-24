import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingEmbedding,
} from '../ports/overlay-store.port.js';

/** How much one pass embeds. Bounded so a backlog is worked, not swallowed. */
export const EMBED_BATCH = 128;

/**
 * Leases a batch of texts waiting to be embedded, then ends the transaction so
 * `EmbedWorker` calls the embedder with no connection held. The lease stops a
 * second worker taking the same batch and expires if one dies mid-call.
 */
export class ClaimEmbeddings extends Command<readonly PendingEmbedding[]> {
  constructor(readonly limit: number = EMBED_BATCH) {
    super();
  }
}

@CommandHandler(ClaimEmbeddings)
export class ClaimEmbeddingsHandler implements ICommandHandler<ClaimEmbeddings> {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(command: ClaimEmbeddings): Promise<readonly PendingEmbedding[]> {
    return this.overlay.claimPending(command.limit, this.clock.now());
  }
}
