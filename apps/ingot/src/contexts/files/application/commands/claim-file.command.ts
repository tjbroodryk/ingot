import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { CLOCK, type Clock } from '../../../../shared/domain/index.js';
import { FILE_QUEUE, type FileQueue, type PendingFile } from '../ports/file-queue.port.js';

/**
 * How many times a document is read before we stop.
 *
 * Four, matching a receipt, and the mix of reasons is why it is not lower. Half
 * the failures here are deterministic and repeat exactly — a PDF with no text
 * layer, a zip that is not the format it claimed — and for those any number
 * above one is waste. The other half are a summariser timing out or a model
 * refusing once, and those are worth a few goes some ticks apart.
 *
 * Four is the number at which the deterministic half has cost four cheap
 * parses and the transient half has had a real chance. What stops it mattering
 * more than that is `ingot_files_abandoned`, which says out loud when something
 * has used them up.
 */
export const MAX_FILE_ATTEMPTS = 4;

/**
 * Takes one queued document, leases it, and hands it over.
 *
 * The first of three, and the split is the point. A document is claimed, read,
 * and its rows are written — with a transaction held for only the first and the
 * last. Doing all three in one command would keep a Postgres connection for the
 * length of a parse, which for a large PDF is tens of seconds, and there are
 * ten in the pool: a handful of concurrent uploads would starve the queries
 * this service exists to answer, while looking like a database problem.
 *
 * So the connection is given back before the bytes are fetched, and a lease on
 * the row is what stops a second worker taking the same document. `FileWorker`
 * runs the three in order.
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
