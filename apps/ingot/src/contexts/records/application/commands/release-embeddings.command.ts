import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
  type PendingEmbedding,
} from '../ports/overlay-store.port.js';

/**
 * Puts a claimed batch back, unembedded.
 *
 * There is no attempt counter here, and that is deliberate — it is the
 * behaviour embedding has always had. A model that is down is a model that
 * will be up, and a text left in the queue is a column that fills in late; a
 * text given up on is a column that stays empty for ever, silently, in a
 * table nobody is watching. Embedding is cheap enough to keep trying.
 *
 * (Receipts are the opposite call: an LLM call costs real money per attempt, so
 * `ClaimReceipt` counts them and stops at four.)
 *
 * Without this the batch would still come back — the lease expires — but not
 * for five minutes, which is a long time to wait out for work already known to
 * have failed.
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
