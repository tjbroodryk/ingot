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
 * Leases a batch of texts waiting to be embedded.
 *
 * A claim of its own, rather than the first half of an `EmbedPending` that
 * also did the embedding, because a hosted embedder is an HTTP round trip and
 * `Dispatcher.send` wraps a command in a transaction. Embedding inside the
 * claim would hold one of ten pooled connections for the length of that call —
 * invisible while the default embedder runs in-process, and a real problem the
 * moment `INGOT_EMBEDDER` names OpenAI or Vertex.
 *
 * So the transaction ends here and `EmbedWorker` makes the call with nothing
 * held. The lease is what a row lock would have been: it stops a second
 * replica buying the same vectors, and it expires so that a worker which died
 * mid-call does not strand the batch.
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
