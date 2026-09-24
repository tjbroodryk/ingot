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
 * Assembles what a session needs from the two tiers. Below the contexts, since
 * query, delete and roll-up must build a table identically. Talks only to ports.
 */
@Injectable()
export class SessionBuilder {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /**
   * One table, as of now. `throughSeq` pins the overlay to a watermark: unset
   * takes everything (query), a value pins it so rows arriving mid-write are
   * neither folded in nor deleted (compaction), `null` wants no overlay rows
   * (delete-only compaction).
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
        // Skip vectors of the wrong width (produced before a model change); mixing widths corrupts ranking.
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
