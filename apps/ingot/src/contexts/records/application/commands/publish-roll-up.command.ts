import { Inject, Logger } from '@nestjs/common';
import { CommandHandler } from '@nestjs/cqrs';
import { CLOCK, type Clock, ConflictingState } from '../../../../shared/domain/index.js';
import { Command, type ICommandHandler } from '../../../../shared/application/index.js';
import { Metrics } from '../../../../observability/index.js';
import { Keys } from '../../../../storage/object-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  IngotId,
  IngotTableId,
  type IngotRepository,
  type IngotTableRepository,
} from '../../../ingots/domain/index.js';
import { GENERATION_GRACE } from '../generation-grace.js';
import { CHANGE_NOTIFIER, type ChangeNotifier } from '../ports/change-notifier.port.js';
import { RETIRED_GENERATIONS, type RetiredGenerations } from '../ports/retired-generations.port.js';
import {
  type FoldedOverlay,
  OVERLAY_STORE,
  type OverlayStore,
} from '../ports/overlay-store.port.js';

export interface CompactionReport {
  readonly table: string;
  readonly generation: number;
  readonly rows: number;
  readonly rowsDrained: number;
}

/** A generation `TableRollUp` has written and uploaded, waiting to be named. */
export interface WrittenGeneration {
  readonly generation: number;
  readonly base: { readonly key: string; readonly rows: number; readonly bytes: number };
  readonly vectors: { readonly key: string; readonly rows: number; readonly bytes: number } | null;
  /** Exactly what went into the files, so exactly that leaves the overlay. */
  readonly folded: FoldedOverlay;
}

/**
 * The transactional end of a roll-up: name the new generation, drain what it
 * folded in, reschedule.
 *
 * Everything slow — DuckDB and the uploads — happened before this, in
 * `TableRollUp`, holding no connection. `written` null is a roll-up that found
 * nothing to write, and only reschedules; a table that no longer exists has
 * whatever it left in the overlay cleared.
 */
export class PublishRollUp extends Command<CompactionReport | null> {
  constructor(
    readonly tableId: string,
    readonly written: WrittenGeneration | null,
    /** The sweep's claim on the table. Null for a roll-up asked for directly. */
    readonly claim: string | null = null,
  ) {
    super();
  }
}

@CommandHandler(PublishRollUp)
export class PublishRollUpHandler implements ICommandHandler<PublishRollUp> {
  private readonly logger = new Logger(PublishRollUpHandler.name);

  constructor(
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(CHANGE_NOTIFIER) private readonly changes: ChangeNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RETIRED_GENERATIONS) private readonly retired: RetiredGenerations,
    @Inject(GENERATION_GRACE) private readonly grace: number,
  ) {}

  async execute(command: PublishRollUp): Promise<CompactionReport | null> {
    // First, and holding the schedule row until commit: a worker whose lease
    // lapsed while it wrote has lost the table to another, and must change
    // nothing about it.
    if (command.claim && !(await this.overlay.holdsRollUpClaim(command.tableId, command.claim))) {
      throw new ConflictingState(
        `the roll-up of ${command.tableId} lost its claim to another worker; it is left to that one.`,
      );
    }

    // A table that is gone was due when it was dropped, or had tombstones its
    // ingot's purge could not find. Nothing will read what it left behind.
    const table = await this.tables.findById(IngotTableId.of(command.tableId));
    const ingot = table && (await this.ingots.findById(IngotId.of(table.ingotId)));
    if (!table || !ingot) {
      await this.overlay.purgeTable(command.tableId);
      return null;
    }

    const { written } = command;
    if (!written) {
      await this.overlay.rescheduleRollUp(table.id.value, this.clock.now());
      return null;
    }

    // Read fresh, so a column `/add` widened while the files were being written
    // is kept rather than lost — Parquet without it reads that column as null.
    // A generation that moved means another roll-up published first.
    if (table.generation !== written.generation - 1) {
      throw new ConflictingState(
        `"${table.name.value}" reached generation ${table.generation} while this roll-up was ` +
          `writing generation ${written.generation}; it is left to the next one.`,
      );
    }

    table.rolledUp({
      base: [written.base],
      vectors: written.vectors ? [written.vectors] : [],
      rows: written.base.rows,
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
    await this.overlay.drain(table.id.value, written.folded);
    // Rows that arrived during the roll-up are scheduled from their own age
    // rather than left behind.
    await this.overlay.rescheduleRollUp(table.id.value, this.clock.now());

    // With the manifest flip, so a receiver told to re-read finds the new
    // generation there. No wake: this runs on the sweeper, which drains
    // deliveries on its own tick.
    await this.changes.rolledUp({
      ingot,
      tableId: table.id.value,
      table: table.name.value,
      generation: written.generation,
      rows: written.base.rows,
      at: this.clock.now(),
    });

    /*
     * Retire the generation this one replaced, rather than deleting it.
     *
     * A query that resolved the manifest a moment ago is still reading it, and
     * so is a caller who downloaded it through `/parquet` and is paging
     * `/pending` against it. `ReapGenerations` deletes it once the grace has
     * passed. Its vectors go with it — they are the same generation.
     */
    const replaced = written.generation - 1;
    if (replaced > 0) {
      const at = this.clock.now();
      const account = ingot.accountId;
      const name = table.name.value;
      await this.retired.retire(
        [
          Keys.generation(account, ingot.id.value, name, replaced),
          Keys.vectorGeneration(account, ingot.id.value, name, replaced),
        ].map((prefix) => ({
          prefix,
          ingotId: ingot.id.value,
          tableId: table.id.value,
          generation: replaced,
        })),
        new Date(at.getTime() + this.grace),
      );
    }

    const drained = written.folded.rowIds.length;
    Metrics.RowsCompacted.inc({}, drained);
    this.logger.log(
      `Rolled "${table.name.value}" up to generation ${written.generation}: ` +
        `${drained} overlay rows folded in, ${written.base.rows} rows in the new base`,
    );

    return {
      table: table.name.value,
      generation: written.generation,
      rows: written.base.rows,
      rowsDrained: drained,
    };
  }
}
