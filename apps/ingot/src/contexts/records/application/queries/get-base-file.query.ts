import type { Readable } from 'node:stream';
import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import { AggregateNotFound, ResourceGone } from '../../../../shared/domain/index.js';
import {
  Query,
  UNIT_OF_WORK,
  type IQueryHandler,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import {
  type ByteRange,
  Keys,
  OBJECT_STORE,
  type ObjectStore,
} from '../../../../storage/object-store.port.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

export interface BaseFileDownload {
  readonly table: string;
  readonly generation: number;
  readonly part: number;
  /** Null for a replaced generation, whose manifest entry is gone. */
  readonly rows: number | null;
  readonly bytes: number;
  /**
   * Rows forgotten since the current generation was written, which it still
   * holds. Null for a replaced generation: the tombstones that applied to it
   * were spent by the roll-up that replaced it.
   */
  readonly tombstones: number | null;
  /** Opens the object, or a range of it. `range` is already checked against `bytes`. */
  open(range?: ByteRange): Promise<Readable>;
}

/** `GET /api/v1/:account/:ingot/tables/:table/parquet?generation=&part=` */
export class GetBaseFile extends Query<BaseFileDownload> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly table: string,
    /** The current generation and its first part unless given. */
    readonly at: { readonly generation?: number; readonly part?: number } = {},
  ) {
    super();
  }
}

/**
 * One Parquet object of a table's base tier, as it is.
 *
 * The current generation is the last roll-up and nothing since: overlay rows
 * are not in it, and rows forgotten after it was written still are. `/pending`
 * lists both, and names the generation it is pending against — which is the
 * one to ask for here, by number, so a download started before a roll-up and
 * finished after it reads one generation throughout.
 *
 * A replaced generation stays readable for `INGOT_GENERATION_GRACE_MS` and is
 * then gone, which is a 410 rather than a 404: it existed, and the caller's
 * next move is to read `/pending` again rather than to check its spelling.
 */
@QueryHandler(GetBaseFile)
export class GetBaseFileHandler implements IQueryHandler<GetBaseFile> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(query: GetBaseFile): Promise<BaseFileDownload> {
    // The manifest and its tombstone count as of one moment, as `/pending` reads them.
    const { ingot, table, tombstones } = await this.uow.snapshot(async () => {
      const ingot = await this.access.ingot(query.ingotId, query.accountId);
      const table = await this.access.table(query.ingotId, query.accountId, query.table);
      return { ingot, table, tombstones: await this.overlay.countTombstones(table.id.value) };
    });

    const name = table.name.value;
    const generation = query.at.generation ?? table.generation;
    const part = query.at.part ?? 1;

    if (generation === table.generation) {
      const file = table.baseFiles[part - 1];
      if (!file) {
        // Never rolled up, or a part this generation does not have.
        throw new AggregateNotFound(
          'Parquet for table',
          `${name} generation ${generation} part ${part}`,
        );
      }
      const found = await this.store.stat(file.key);
      if (!found) {
        throw new Error(`The manifest for "${name}" names ${file.key}, which is not in the store`);
      }
      return this.download(name, generation, part, file.key, found.bytes, file.rows, tombstones);
    }

    if (generation < 1 || generation > table.generation) {
      throw new AggregateNotFound('Parquet for table', `${name} generation ${generation}`);
    }

    const key = Keys.part(ingot.accountId, ingot.id.value, name, generation, part);
    const found = await this.store.stat(key);
    if (!found) {
      throw new ResourceGone(
        `generation ${generation} of "${name}" has been replaced and deleted; the table is at ` +
          `generation ${table.generation}. Read /pending again and download that one.`,
      );
    }
    return this.download(name, generation, part, key, found.bytes, null, null);
  }

  private download(
    table: string,
    generation: number,
    part: number,
    key: string,
    bytes: number,
    rows: number | null,
    tombstones: number | null,
  ): BaseFileDownload {
    return {
      table,
      generation,
      part,
      rows,
      bytes,
      tombstones,
      open: (range) => this.store.open(key, range),
    };
  }
}
