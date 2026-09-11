import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { AggregateNotFound } from '../../../../shared/domain/index.js';
import {
  Command,
  UNIT_OF_WORK,
  type ICommandHandler,
  type UnitOfWork,
} from '../../../../shared/application/index.js';
import { Metrics, Outcome, observe } from '../../../../observability/index.js';
import {
  ANALYTICAL_ENGINE,
  type AnalyticalEngine,
} from '../../../../engine/analytical-engine.port.js';
import { SessionBuilder } from '../../../../engine/session-builder.js';
import { Keys, OBJECT_STORE, type ObjectStore } from '../../../../storage/object-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  IngotId,
  IngotTableId,
  type IngotRepository,
  type IngotTableRepository,
} from '../../../ingots/domain/index.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

export interface CompactionReport {
  readonly table: string;
  readonly generation: number;
  readonly rows: number;
  readonly rowsDrained: number;
}

/**
 * Rolls one table's overlay up into a new Parquet generation.
 *
 * Dispatched by the sweeper on a schedule and by nothing else — but a command
 * rather than a method on the sweeper, because "reconcile" should be the same
 * write path as everything else rather than a second implementation that can
 * disagree with it.
 */
export class CompactTable extends Command<CompactionReport | null> {
  constructor(readonly tableId: string) {
    super();
  }
}

@CommandHandler(CompactTable)
export class CompactTableHandler implements ICommandHandler<CompactTable> {
  private readonly logger = new Logger(CompactTableHandler.name);

  constructor(
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(ANALYTICAL_ENGINE) private readonly engine: AnalyticalEngine,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly sessions: SessionBuilder,
  ) {}

  async execute(command: CompactTable): Promise<CompactionReport | null> {
    const table = await this.tables.findById(IngotTableId.of(command.tableId));
    if (!table) throw new AggregateNotFound('Table', command.tableId);

    const ingot = await this.ingots.findById(IngotId.of(table.ingotId));
    if (!ingot) throw new AggregateNotFound('Ingot', table.ingotId);

    /*
     * The watermark, read once and used twice.
     *
     * Everything at or below it goes into the new Parquet, and afterwards
     * everything at or below it is deleted from the overlay. Rows written
     * while the file is being produced have a higher sequence: they are not in
     * the file, and they are not deleted. Without this the window between
     * writing and draining silently loses whatever arrived in it.
     */
    const watermark = await this.overlay.watermark(table.id.value);

    /*
     * A roll-up has two reasons to run, and the second is easy to miss.
     *
     * Rows in the overlay are rows to fold in. Tombstones are rows to leave
     * out — and a delete writes no overlay rows at all, so a table that is
     * only ever deleted from has a null watermark and would never be
     * rewritten. Its forgotten rows would sit in the base file indefinitely,
     * filtered out on every query, and the tombstone set would only grow.
     */
    const tombstones = await this.overlay.countTombstones(table.id.value);
    if (watermark === null && tombstones === 0) {
      // Nothing moved. Sweeps over a quiet table write nothing and say nothing.
      return null;
    }

    const generation = table.generation + 1;
    const baseTarget = Keys.part(ingot.accountId, ingot.id.value, table.name.value, generation, 1);
    const vectorTarget = Keys.vectors(
      ingot.accountId,
      ingot.id.value,
      table.name.value,
      generation,
    );

    const pending = await this.overlay.count(table.id.value);
    const view = await this.sessions.materialisable(table, watermark);

    const started = performance.now();
    const outcome = await observe('ingot.compact', { 'ingot.generation': generation }, () =>
      this.engine.compact({ table: view, baseTarget, vectorTarget }),
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

    const [baseStat, vectorStat] = await Promise.all([
      this.store.stat(baseTarget),
      outcome.vectors > 0 ? this.store.stat(vectorTarget) : Promise.resolve(null),
    ]);

    table.rolledUp({
      base: [{ key: baseTarget, rows: outcome.rows, bytes: baseStat?.bytes ?? 0 }],
      vectors:
        outcome.vectors > 0
          ? [{ key: vectorTarget, rows: outcome.vectors, bytes: vectorStat?.bytes ?? 0 }]
          : [],
      rows: outcome.rows,
    });

    /*
     * Manifest first, overlay second, and the old generation left in place.
     *
     * A query that resolved the manifest a moment ago is still reading
     * generation n, whose files are untouched — a separate, later sweep reaps
     * those once nothing can still be mid-flight. So both the old plan and the
     * new one are individually complete at every instant, which is the whole
     * correctness argument for the two tiers.
     */
    await this.tables.save(table);
    /*
     * The view is what the engine was given, so its vectors are the ones the
     * new file holds. Handing them back is what lets the drain tell an
     * embedding it has written from one that is still owed — the two are
     * indistinguishable from the rows alone.
     */
    await this.overlay.drain(
      table.id.value,
      watermark,
      view.overlayVectors.map((vector) => ({ rowId: vector.rowId, column: vector.column })),
    );

    /*
     * Reap the generation two behind, after the commit.
     *
     * Generation n-1 stays, because a query that resolved the manifest just
     * before this flip is still reading it. Two generations of grace against a
     * fifteen-second query timeout and a five-minute sweep is a wide margin,
     * and the cost of being wrong in this direction is an object that lingers
     * rather than a query that fails.
     *
     * No listing is needed: the path is derived, and removing a prefix that is
     * not there is a no-op, which makes this safe to run every time.
     */
    const stale = generation - 2;
    if (stale > 0) {
      const prefix = Keys.generation(ingot.accountId, ingot.id.value, table.name.value, stale);
      this.uow.afterCommit(() => this.store.removePrefix(prefix));
    }

    Metrics.RowsCompacted.inc({}, pending);
    this.logger.log(
      `Rolled "${table.name.value}" up to generation ${generation}: ` +
        `${pending} overlay rows folded in, ${outcome.rows} rows in the new base`,
    );

    return {
      table: table.name.value,
      generation,
      rows: outcome.rows,
      rowsDrained: pending,
    };
  }
}
