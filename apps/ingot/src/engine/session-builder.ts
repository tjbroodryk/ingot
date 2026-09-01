import { Inject, Injectable } from '@nestjs/common';
import { EMBEDDER, type Embedder } from '../ai/embedder.port.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../contexts/records/application/ports/overlay-store.port.js';
import type { IngotTable } from '../contexts/ingots/domain/index.js';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import type { MaterialisableTable, RowVector } from './analytical-engine.port.js';

/**
 * Assembles what a session needs from the two tiers.
 *
 * Sits below the contexts rather than inside one because three callers want
 * exactly the same assembly and must not diverge: a query, a delete resolving
 * its predicate, and a roll-up. If compaction built its view of a table even
 * slightly differently from the query path, "the same query returns the same
 * answer either side of a roll-up" would stop being true — and that property
 * is the whole justification for having two tiers at all.
 *
 * It talks only to ports, which is what keeps it honest about layering: it
 * knows there is a manifest, an overlay and an object store, and nothing about
 * how any of them is implemented.
 */
@Injectable()
export class SessionBuilder {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /**
   * One table, as of now.
   *
   * `throughSeq` pins the overlay to a watermark. A query leaves it open and
   * gets everything; a compaction pins it, so that rows arriving while the
   * Parquet is being written are neither included in the file nor deleted
   * afterwards. `null` is the compaction that had no rows to fold in and is
   * running only to apply deletes — it wants nothing from the overlay.
   */
  async materialisable(
    table: IngotTable,
    throughSeq?: bigint | null,
  ): Promise<MaterialisableTable> {
    const [overlayRows, tombstones] = await Promise.all([
      throughSeq === null ? [] : this.overlay.read(table.id.value, throughSeq),
      this.overlay.tombstones(table.id.value),
    ]);

    const embedded = table.embeddedColumns.map((column) => ({
      column: column.name.value,
      dimensions: this.embedder.dimensions,
    }));

    const overlayVectors: RowVector[] = [];
    for (const entry of embedded) {
      const vectors = await this.overlay.readVectors(table.id.value, entry.column);
      for (const vector of vectors) {
        // A vector of the wrong width is one the embedder produced before the
        // model changed. Dropping it silently would mix two vector spaces in
        // one ranking, which reads as "search got worse" and nothing else.
        if (vector.vector.length !== entry.dimensions) continue;
        overlayVectors.push({ rowId: vector.rowId, column: entry.column, vector: vector.vector });
      }
    }

    return {
      name: table.name.value,
      columns: table.columns.map((column) => ({
        name: column.name.value,
        type: column.type,
      })),
      baseFiles: table.baseFiles.map((file) => this.store.uri(file.key)),
      vectorFiles: table.vectorFiles.map((file) => this.store.uri(file.key)),
      overlayRows: overlayRows.map((row) => row.payload),
      overlayVectors,
      tombstones: [...tombstones],
      embedded,
      fts: table.config.fts.toWire(),
    };
  }

  /** Every table of an ingot, for a query that could name any of them. */
  async all(tables: readonly IngotTable[]): Promise<readonly MaterialisableTable[]> {
    return Promise.all(tables.map((table) => this.materialisable(table)));
  }
}
