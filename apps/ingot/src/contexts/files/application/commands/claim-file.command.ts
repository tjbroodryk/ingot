import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { FILE_QUEUE, type FileQueue, type PendingFile } from '../ports/file-queue.port.js';

/** Times a document is read before it is abandoned. */
export const MAX_FILE_ATTEMPTS = 4;

/**
 * Leases one queued document and hands it over.
 *
 * First of three commands; the document is parsed between claim and write, with
 * no transaction held across the parse.
 */
export class ClaimFile extends Command<PendingFile | null> {}

@CommandHandler(ClaimFile)
export class ClaimFileHandler implements ICommandHandler<ClaimFile> {
  constructor(
    @Inject(FILE_QUEUE) private readonly queue: FileQueue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<PendingFile | null> {
    return this.queue.claim(MAX_FILE_ATTEMPTS, this.clock.now());
  }
}
