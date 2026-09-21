import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import type { IngotTable } from '../../src/contexts/ingots/domain/index.js';
import { SessionBuilder } from '../../src/engine/session-builder.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * A query reads the overlay of the tables it names, and no others.
 *
 * Each table's overlay is a Postgres read and a copy into the session, so an
 * ingot with ten busy tables used to charge a one-table query for all ten. The
 * load test that found it is `load/multi-table.js`.
 */
describe('which tables a query reads', () => {
  let world: World;
  let ingot: string;
  let built: string[][];

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('several tables');
    for (const table of ['alpha', 'beta', 'gamma']) {
      await world.add(ingot, {
        table,
        key: ['sha'],
        columns: {
          sha: { from: '$.sha', type: ColumnType.Varchar },
          n: { from: '$.n', type: ColumnType.Integer },
        },
        result: { sha: 'abc', n: table.length },
      });
    }

    const sessions = world.app.get(SessionBuilder);
    const all = sessions.all.bind(sessions);
    built = [];
    sessions.all = (tables: readonly IngotTable[]) => {
      built.push(tables.map((table) => table.name.value).sort());
      return all(tables);
    };
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('reads only the table a statement names', async () => {
    built.length = 0;
    expect(await world.sql(ingot, 'SELECT n FROM alpha')).toEqual([{ n: 5 }]);
    expect(built).toEqual([['alpha']]);
  });

  it('reads both sides of a join', async () => {
    built.length = 0;
    const rows = await world.sql(
      ingot,
      'SELECT alpha.n AS a, gamma.n AS g FROM alpha JOIN gamma ON alpha.sha = gamma.sha',
    );
    expect(rows).toEqual([{ a: 5, g: 5 }]);
    expect(built).toEqual([['alpha', 'gamma']]);
  });

  // DuckDB extracts no names from a USING join, indistinguishably from a
  // statement it cannot parse, so this is the fallback doing its job.
  it('reads everything when the statement cannot be narrowed', async () => {
    built.length = 0;
    const rows = await world.sql(ingot, 'SELECT count(*) AS n FROM alpha JOIN beta USING (sha)');
    expect(rows).toEqual([{ n: '1' }]);
    expect(built).toEqual([['alpha', 'beta', 'gamma']]);
  });

  it('matches names regardless of case', async () => {
    built.length = 0;
    await world.sql(ingot, 'SELECT n FROM BETA');
    expect(built).toEqual([['beta']]);
  });
});
