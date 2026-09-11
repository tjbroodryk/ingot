import { describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { TableRegistry } from '../../src/contexts/ingots/application/table-registry.js';
import {
  ColumnSpec,
  IngotTable,
  type IngotTableId,
  type IngotTableRepository,
} from '../../src/contexts/ingots/domain/index.js';
import {
  CHUNKS_TABLE,
  CHUNK_OCR,
  declareChunksTable,
} from '../../src/contexts/files/domain/file-tables.js';

/**
 * A system table that predates a column this build declares for it.
 *
 * This is a regression test with a story. `ocr` was added to
 * `ingot_file_chunks`, and `TableRegistry.ensure` returns an existing table
 * untouched — so every memory created before the release kept the schema it
 * was made with, while `/file` went on handing back a `chunksQuery` naming the
 * new column. The promissory note answered `Binder Error: Referenced column
 * "ocr" not found in FROM clause` for every document in every one of them, and
 * no amount of re-uploading fixed it.
 *
 * The distinction the fix rests on is whose schema it is. A caller's table
 * belongs to their mapping and nothing else may widen it. A system table's
 * belongs to this codebase, which means a release that adds a column to one
 * has to add it to the tables already out there.
 */

/** The repository, in memory. Enough to watch what the registry saves. */
class Tables implements IngotTableRepository {
  saves = 0;
  private readonly held = new Map<string, IngotTable>();

  constructor(existing: readonly IngotTable[] = []) {
    for (const table of existing) this.held.set(key(table.ingotId, table.name.value), table);
  }

  save(table: IngotTable): Promise<void> {
    this.saves++;
    this.held.set(key(table.ingotId, table.name.value), table);
    return Promise.resolve();
  }

  findByName(ingotId: string, name: string): Promise<IngotTable | null> {
    return Promise.resolve(this.held.get(key(ingotId, name)) ?? null);
  }

  findById(_id: IngotTableId): Promise<IngotTable | null> {
    return Promise.resolve(null);
  }

  listForIngot(ingotId: string): Promise<readonly IngotTable[]> {
    return Promise.resolve([...this.held.values()].filter((table) => table.ingotId === ingotId));
  }

  remove(_id: IngotTableId): Promise<void> {
    return Promise.resolve();
  }
}

function key(ingotId: string, name: string): string {
  return `${ingotId}/${name}`;
}

const INGOT = 'ing_7f2c';
const NOW = new Date('2026-09-10T12:00:00Z');

/** The chunk table as it was declared before `ocr` existed. */
function asItWas(): IngotTable {
  const current = declareChunksTable(INGOT, NOW);

  return IngotTable.declare({
    ingotId: INGOT,
    name: CHUNKS_TABLE,
    system: true,
    raw: false,
    key: ['file_id', 'ordinal'],
    now: NOW,
    // `_row_id` and friends are added by `declare` itself and may not be
    // re-declared, so the fixture passes only the columns the file actually
    // names — minus the one this release added.
    columns: current.columns
      .filter((column) => !column.name.value.startsWith('_') && column.name.value !== CHUNK_OCR)
      .map((column) =>
        ColumnSpec.of({
          name: column.name.value,
          type: column.type,
          embedded: column.embedded,
          required: column.required,
        }),
      ),
  });
}

describe('a system table declared by an older release', () => {
  it('gains the column this build declares for it', async () => {
    const old = asItWas();
    expect(old.columns.map((column) => column.name.value)).not.toContain(CHUNK_OCR);

    const tables = new Tables([old]);
    const table = await new TableRegistry(tables).ensureCurrent(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(table.columns.map((column) => column.name.value)).toContain(CHUNK_OCR);
    expect(tables.saves).toBe(1);
  });

  /**
   * Added optional, on the same terms `/add` widens a caller's table: the
   * Parquet already written has no such column, and the rows in it are not
   * wrong — a chunk stored before OCR existed was read out of a text layer,
   * which is exactly what a null in this column means.
   */
  it('adds it optional, so the rows already written stay valid', async () => {
    const tables = new Tables([asItWas()]);
    const table = await new TableRegistry(tables).ensureCurrent(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(table.columns.find((column) => column.name.value === CHUNK_OCR)?.required).toBe(false);
  });

  /**
   * The steady state, which is every write after the first one following a
   * release. `save` contends on the table's version, and a memory under load
   * writes chunks constantly — so a reconcile that found nothing to do must
   * not touch the row.
   */
  it('writes nothing when the schema already matches', async () => {
    const tables = new Tables([declareChunksTable(INGOT, NOW)]);
    await new TableRegistry(tables).ensureCurrent(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(tables.saves).toBe(0);
  });

  it('still creates the table when there is none, and saves it once', async () => {
    const tables = new Tables();
    const table = await new TableRegistry(tables).ensureCurrent(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(table.columns.map((column) => column.name.value)).toContain(CHUNK_OCR);
    expect(tables.saves).toBe(1);
  });

  /**
   * A caller's table is not this codebase's to widen — only their mapping is,
   * and `add-records.command.ts` is where that happens. `ensure` is what the
   * two caller-owned paths keep using, and this is the assertion that says the
   * fix did not quietly change them.
   */
  it('leaves a table alone when it is reached through plain ensure', async () => {
    const tables = new Tables([asItWas()]);
    const table = await new TableRegistry(tables).ensure(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(table.columns.map((column) => column.name.value)).not.toContain(CHUNK_OCR);
    expect(tables.saves).toBe(0);
  });

  it('refuses a column whose type moved, rather than widening it', async () => {
    const wrong = IngotTable.declare({
      ingotId: INGOT,
      name: CHUNKS_TABLE,
      system: true,
      raw: false,
      key: ['file_id', 'ordinal'],
      now: NOW,
      columns: [
        ColumnSpec.of({ name: 'file_id', type: ColumnType.Varchar }),
        ColumnSpec.of({ name: 'ordinal', type: ColumnType.Integer }),
        // The same name, a different type: a release cannot fix this by
        // declaring it, and pretending otherwise would rewrite what a saved
        // query returns.
        ColumnSpec.of({ name: CHUNK_OCR, type: ColumnType.Integer }),
      ],
    });

    const registry = new TableRegistry(new Tables([wrong]));
    expect(
      registry.ensureCurrent(INGOT, CHUNKS_TABLE, () => declareChunksTable(INGOT, NOW)),
    ).rejects.toThrow(/cannot change/);
  });
});
