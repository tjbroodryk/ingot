import { Inject } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import type { CloneIngotBody } from '@ingot/shared/ingot-v1';
import { CLOCK, type Clock, ConflictingState } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import type { Isolation } from '../../../../shared/application/ports/unit-of-work.port.js';
import { MAX_FILE_ATTEMPTS } from '../../../files/application/commands/claim-file.command.js';
import { FILE_QUEUE, type FileQueue } from '../../../files/application/ports/file-queue.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import { Keys, OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  Ingot,
  type IngotRepository,
  type IngotTableRepository,
} from '../../domain/index.js';
import { IngotAccess } from '../ingot-access.js';
import { summarise } from '../ingot-summary.js';
import type { CreatedIngot } from './create-ingot.command.js';

/** `POST /api/v1/:account/:ingot/clone` */
export class CloneIngot extends Command<CreatedIngot> {
  /**
   * The manifest, the overlay, the vectors and the embedding queue are read
   * by a dozen statements, and a roll-up or an embedding committing between
   * two of them would put a row in neither copy. One snapshot makes them agree
   * without locking the source against its own writers.
   */
  override readonly isolation: Isolation = 'repeatable read';

  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly body: CloneIngotBody,
  ) {
    super();
  }
}

/**
 * Copies a memory: its tables, their current Parquet, and everything in the
 * overlay, under a new id.
 *
 * The source is read as of the snapshot this transaction opened. A roll-up
 * that commits while the copy runs retires the generation being copied rather
 * than deleting it, and the grace before it is reaped is what keeps those
 * files there until the copy is done.
 *
 * Two things are not copied. Documents still being parsed are refused rather
 * than copied: their rows do not exist yet, and a queue entry names the
 * source's file id, so a copy would parse into the source. And receipts still
 * waiting for a summary stay with the source — the queue is keyed by batch,
 * and a batch is the source's.
 *
 * Objects are copied before the rows naming them are written. If the
 * transaction fails, the copies are removed; if that fails too, they are
 * orphans under a prefix nothing references, which cost storage and nothing
 * else.
 */
@CommandHandler(CloneIngot)
export class CloneIngotHandler implements ICommandHandler<CloneIngot> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(FILE_QUEUE) private readonly files: FileQueue,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CloneIngot): Promise<CreatedIngot> {
    try {
      return await this.clone(command);
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      // Only a keyed clone writes anything a concurrent transaction can also
      // write: the `externalId`. Asking again answers with whichever won.
      throw new ConflictingState(
        `a memory with externalId "${command.body.externalId}" was being created at the ` +
          'same time. Try again.',
      );
    }
  }

  private async clone(command: CloneIngot): Promise<CreatedIngot> {
    const source = await this.access.ingot(command.ingotId, command.accountId);
    const now = this.clock.now();
    const clone = Ingot.cloneOf(source, { ...command.body, now });

    if (clone.externalId !== null) {
      const existing = await this.ingots.findByExternalId(command.accountId, clone.externalId);
      if (existing && !existing.hasExpired(now)) {
        return { ingot: await summarise(existing, this.tables, this.overlay), created: false };
      }
      if (existing) {
        existing.releaseExternalId();
        await this.ingots.save(existing);
      }
    }

    const parsing = await this.files.pendingFor(source.id.value, MAX_FILE_ATTEMPTS);
    if (parsing > 0) {
      throw new ConflictingState(
        `${parsing} document${parsing === 1 ? ' is' : 's are'} still being parsed into this ` +
          'memory. Clone it once they have finished — waitForDocument, or the query /file ' +
          'returned, says when.',
      );
    }

    if (clone.externalId === null) {
      await this.ingots.save(clone);
    } else if (!(await this.ingots.claim(clone))) {
      throw new ConflictingState(
        `a memory with externalId "${clone.externalId}" was being created at the same time. ` +
          'Try again.',
      );
    }

    const from = Keys.ingot(source.accountId, source.id.value);
    const to = Keys.ingot(clone.accountId, clone.id.value);
    const rekey = (key: string): string => {
      if (!key.startsWith(`${from}/`)) {
        throw new Error(`"${key}" is not under the prefix of the memory it belongs to`);
      }
      return `${to}${key.slice(from.length)}`;
    };

    try {
      for (const table of await this.tables.listForIngot(source.id.value)) {
        const copy = table.copyInto(clone.id.value, rekey, now);
        const files = [...table.baseFiles, ...table.vectorFiles];
        await Promise.all(files.map((file) => this.store.copy(file.key, rekey(file.key))));

        await this.tables.save(copy);
        await this.overlay.copyTable({
          fromTableId: table.id.value,
          toTableId: copy.id.value,
          toIngotId: clone.id.value,
        });
      }
      return { ingot: await summarise(clone, this.tables, this.overlay), created: true };
    } catch (error) {
      await this.store.removePrefix(to).catch(() => undefined);
      throw error;
    }
  }
}

/** Postgres's `40001`, wherever the driver or Drizzle put it. */
function isSerializationFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '40001') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
