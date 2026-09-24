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
 * `ensure` returns an existing table untouched; `ensureCurrent` adds columns
 * this build declares. A system table's schema belongs to this codebase, a
 * caller's to their mapping.
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
    // `declare` adds `_row_id` and friends itself, so the fixture passes only
    // the file's own columns, minus the one this build added.
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

  it('adds it optional, so the rows already written stay valid', async () => {
    const tables = new Tables([asItWas()]);
    const table = await new TableRegistry(tables).ensureCurrent(INGOT, CHUNKS_TABLE, () =>
      declareChunksTable(INGOT, NOW),
    );

    expect(table.columns.find((column) => column.name.value === CHUNK_OCR)?.required).toBe(false);
  });

  // `save` contends on the table's version, so a reconcile with nothing to do
  // must not touch the row.
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

  // `ensure` is the caller-owned path and does not widen; only `ensureCurrent` does.
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
        // Same name, different type: this cannot be reconciled, only refused.
        ColumnSpec.of({ name: CHUNK_OCR, type: ColumnType.Integer }),
      ],
    });

    const registry = new TableRegistry(new Tables([wrong]));
    expect(
      registry.ensureCurrent(INGOT, CHUNKS_TABLE, () => declareChunksTable(INGOT, NOW)),
    ).rejects.toThrow(/cannot change/);
  });
});
