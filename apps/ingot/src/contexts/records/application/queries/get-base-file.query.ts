import type { Readable } from 'node:stream';
import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import { AggregateNotFound, ConflictingState } from '../../../../shared/domain/index.js';
import { Query, type IQueryHandler } from '../../../../shared/application/index.js';
import { OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

export interface BaseFileDownload {
  readonly table: string;
  readonly generation: number;
  readonly rows: number;
  readonly bytes: number;
  /** Rows forgotten since this file was written. It still holds them. */
  readonly tombstones: number;
  readonly body: Readable;
}

/** `GET /api/v1/:account/:ingot/tables/:table/parquet` */
export class GetBaseFile extends Query<BaseFileDownload> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly table: string,
  ) {
    super();
  }
}

/**
 * A table's base tier, as the Parquet file itself.
 *
 * The file is the last roll-up and nothing since: overlay rows are not in it,
 * and rows forgotten after it was written still are. `/pending` lists both, and
 * the tombstone count travels with the download so a caller can tell a file
 * that is the whole answer from one that needs them applied.
 *
 * The old generation is reaped two roll-ups later, so a download that outlives
 * two sweeps can be cut short. That is the same grace a query gets.
 */
@QueryHandler(GetBaseFile)
export class GetBaseFileHandler implements IQueryHandler<GetBaseFile> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async execute(query: GetBaseFile): Promise<BaseFileDownload> {
    const table = await this.access.table(query.ingotId, query.accountId, query.table);

    const [file, ...more] = table.baseFiles;
    if (!file) {
      // Never rolled up: every row it has is still in the overlay.
      throw new AggregateNotFound('Parquet for table', table.name.value);
    }
    if (more.length > 0) {
      // Compaction writes one part per generation today. A manifest with more
      // wants a route that can name the part, not a silently partial download.
      throw new ConflictingState(
        `table "${table.name.value}" is ${table.baseFiles.length} Parquet files, and this ` +
          'endpoint serves a table held in one',
      );
    }

    const found = await this.store.stat(file.key);
    if (!found) {
      throw new Error(
        `The manifest for "${table.name.value}" names ${file.key}, which is not in the store`,
      );
    }
    const tombstones = await this.overlay.countTombstones(table.id.value);

    return {
      table: table.name.value,
      generation: table.generation,
      rows: file.rows,
      bytes: found.bytes,
      tombstones,
      body: await this.store.open(file.key),
    };
  }
}
