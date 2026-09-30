import { Inject, Injectable } from '@nestjs/common';
import { Dispatcher } from '../../../shared/application/index.js';
import { Metrics, Outcome, observe } from '../../../observability/index.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
} from '../../../engine/analytical-engine.port.js';
import { SessionBuilder } from '../../../engine/session-builder.js';
import { Keys, OBJECT_STORE, type ObjectStore } from '../../../storage/object-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  IngotId,
  IngotTableId,
  type IngotRepository,
  type IngotTableRepository,
} from '../../ingots/domain/index.js';
import { type CompactionReport, PublishRollUp } from './commands/publish-roll-up.command.js';
import { OVERLAY_STORE, type OverlayStore } from './ports/overlay-store.port.js';

/**
 * Rolls one table's overlay up into a new Parquet generation.
 *
 * In two halves, and only the second holds a transaction. This half reads the
 * table and its overlay, has DuckDB write the files and uploads them — the
 * part that takes a second — with no connection held; `PublishRollUp` then
 * names the new generation and drains the overlay in one short transaction.
 * A roll-up that holds a connection for its uploads can run only as many at
 * once as the pool has connections.
 *
 * Nothing reads the new files until `PublishRollUp` names them, so a roll-up
 * that fails part-way leaves the table as it was. Its files sit at the next
 * generation's keys, which the next roll-up overwrites.
 */
@Injectable()
export class TableRollUp {
  constructor(
    private readonly dispatcher: Dispatcher,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(ANALYTICAL_ENGINE) private readonly engine: AnalyticalEngine,
    private readonly sessions: SessionBuilder,
  ) {}

  /** `claim` is the sweep's hold on the table; a roll-up asked for directly has none. */
  async run(tableId: string, claim?: HeldClaim): Promise<CompactionReport | null> {
    const token = claim?.token ?? null;
    const table = await this.tables.findById(IngotTableId.of(tableId));
    const ingot = table && (await this.ingots.findById(IngotId.of(table.ingotId)));
    if (!table || !ingot) return this.dispatcher.send(new PublishRollUp(tableId, null, token));

    /*
     * A roll-up has two reasons to run, and the second is easy to miss.
     *
     * Rows in the overlay are rows to fold in. Tombstones are rows to leave
     * out — and a delete writes no overlay rows at all, so a table that is
     * only ever deleted from has a null watermark and would never be
     * rewritten. Its forgotten rows would sit in the base file indefinitely,
     * filtered out on every query, and the tombstone set would only grow.
     */
    const watermark = await this.overlay.watermark(table.id.value);
    const tombstones = await this.overlay.countTombstones(table.id.value);
    if (watermark === null && tombstones === 0) {
      // Nothing moved. Sweeps over a quiet table write nothing and say nothing.
      return this.dispatcher.send(new PublishRollUp(tableId, null, token));
    }

    const generation = table.generation + 1;
    const baseTarget = Keys.part(ingot.accountId, ingot.id.value, table.name.value, generation, 1);
    const vectorTarget = Keys.vectors(
      ingot.accountId,
      ingot.id.value,
      table.name.value,
      generation,
    );
    const view = await this.sessions.materialisable(table, watermark);

    const started = performance.now();
    const outcome = await observe('ingot.compact', { 'ingot.generation': generation }, () =>
      this.engine.compact({
        table: view,
        baseTarget,
        vectorTarget,
        // The keys are the next generation's, so a worker whose claim lapsed
        // must not upload to them: whoever took the table may have published.
        beforeCommit: claim ? () => claim.confirm() : undefined,
      }),
    ).catch((error: unknown) => {
      Metrics.CompactionDuration.observe(
        { outcome: Outcome.Error },
        (performance.now() - started) / 1000,
      );
      throw error;
    });
    Metrics.CompactionDuration.observe(
      { outcome: Outcome.Ok },
      (performance.now() - started) / 1000,
    );

    // Asked of the store only when the write did not already say.
    const [baseBytes, vectorBytes] = await Promise.all([
      outcome.baseBytes ?? this.store.stat(baseTarget).then((found) => found?.bytes ?? 0),
      outcome.vectors === 0
        ? 0
        : (outcome.vectorBytes ?? this.store.stat(vectorTarget).then((found) => found?.bytes ?? 0)),
    ]);

    return this.dispatcher.send(
      new PublishRollUp(
        tableId,
        {
          generation,
          base: { key: baseTarget, rows: outcome.rows, bytes: baseBytes },
          vectors:
            outcome.vectors > 0
              ? { key: vectorTarget, rows: outcome.vectors, bytes: vectorBytes }
              : null,
          /*
           * What the view held, not everything at or below the watermark. A
           * write can take a lower sequence than the watermark and commit after
           * the view was read; it is not in the file, so it must not be drained.
           * Tombstones likewise: one written after the view was read has not
           * been applied to the file yet. The vectors are how the drain tells an
           * embedding the file holds from one that is still owed.
           */
          folded: {
            rowIds: view.overlayRows.map((row) => String(row._row_id)),
            tombstones: view.tombstones,
            vectors: view.overlayVectors.map((vector) => ({
              rowId: vector.rowId,
              column: vector.column,
            })),
          },
        },
        token,
      ),
    );
  }
}

/** A sweep's hold on a table: the token that fences its publish, and a way to renew it. */
export interface HeldClaim {
  readonly token: string;
  /** Renews the lease; throws when another worker holds the table now. */
  confirm(): Promise<void>;
}
