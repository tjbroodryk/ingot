import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * `_raw` is the blob a row was projected from. Withheld from the default
 * projection, but still readable when a caller names it.
 */
describe('_raw', () => {
  let world: World;
  let withRaw: string;
  let withoutRaw: string;

  beforeAll(async () => {
    world = await makeWorld();

    withRaw = await world.ingot('a memory that keeps the blob');
    await world.add(withRaw, {
      table: 'results',
      raw: true,
      columns: {
        output: { from: '$.output', type: ColumnType.Varchar, embed: true },
        tool: { from: '$.tool', type: ColumnType.Varchar },
      },
      result: { output: 'the migration broke on a missing index', tool: 'Bash' },
    });

    withoutRaw = await world.ingot('a memory that does not');
    await world.add(withoutRaw, {
      table: 'results',
      columns: { output: { from: '$.output', type: ColumnType.Varchar, embed: true } },
      result: { output: 'the migration broke on a missing index' },
    });

    expect(await world.embedAll()).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('is not in a plaintext search, which is where it used to double the answer', async () => {
    const found = await world.query(withRaw, { text: 'the migration broke', table: 'results' });

    expect(found.rows.length).toBe(1);
    expect(found.columns).not.toContain('_raw');
    expect(Object.keys(found.rows[0] as object)).not.toContain('_raw');
    // Withholding it is not withholding the answer.
    expect(found.rows[0]).toHaveProperty('output');
    expect(found.rows[0]).toHaveProperty('score');
  });

  it('still comes back when a caller names it, because they stored it on purpose', async () => {
    const found = await world.query(withRaw, { sql: 'SELECT _raw FROM results' });

    expect(found.rows.length).toBe(1);
    expect(found.rows[0]).toHaveProperty('_raw');
    expect(String((found.rows[0] as Record<string, unknown>)._raw)).toContain('migration');
  });

  it('does not break a search on a table that never had one', async () => {
    // `EXCLUDE` on an absent column is a DuckDB error, so exclusion must be
    // conditional on the column existing.
    const found = await world.query(withoutRaw, { text: 'the migration broke', table: 'results' });

    expect(found.rows.length).toBe(1);
    expect(found.rows[0]).toHaveProperty('output');
  });
});
