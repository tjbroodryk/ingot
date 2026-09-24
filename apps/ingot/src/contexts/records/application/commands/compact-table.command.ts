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
 * Rolls one table's overlay up into a new Parquet generation. Dispatched by the
 * sweeper; a command rather than a sweeper method so it shares the one write path.
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

    // Read once and used twice: everything at or below it is folded into the
    // new Parquet and then deleted from the overlay. Rows written during the
    // file's production have a higher sequence and survive.
    const watermark = await this.overlay.watermark(table.id.value);

    // A delete writes no overlay rows, so a table only ever deleted from has a
    // null watermark; count tombstones too, or its forgotten rows would sit in
    // the base file forever.
    const tombstones = await this.overlay.countTombstones(table.id.value);
    if (watermark === null && tombstones === 0) {
      // Nothing moved.
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

    // Manifest first, overlay second, old generation left in place: a query
    // that resolved the manifest a moment ago still reads generation n
    // untouched. A later sweep reaps it, so both plans stay complete throughout.
    await this.tables.save(table);
    await this.overlay.drain(table.id.value, watermark);

    // Reap the generation two behind, after the commit. Generation n-1 stays
    // for queries that resolved the manifest just before the flip. The path is
    // derived, so removing a prefix that is not there is a safe no-op.
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
