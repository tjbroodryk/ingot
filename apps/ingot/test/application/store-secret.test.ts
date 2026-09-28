import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { FilesystemObjectStore } from '../../src/storage/filesystem-object-store.js';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

// The filesystem store installs no secret, so this one stands in for S3's and
// GCS's. `http` is the one secret type DuckDB has without httpfs.
class SecretStore extends FilesystemObjectStore {
  override async session(): Promise<readonly string[]> {
    return ["CREATE OR REPLACE SECRET ingot_base (TYPE HTTP, BEARER_TOKEN 'tok_not_for_callers')"];
  }
}

describe("the store's secret", () => {
  let world: World;
  let ingot: string;

  beforeAll(async () => {
    world = await makeWorld({ store: (dataDir) => new SecretStore(dataDir) });
    ingot = await world.ingot('an ingot with a rolled-up table');
    await world.add(ingot, {
      table: 'notes',
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      result: { body: 'in the base tier' },
    });
    // The secret is only installed for a session that reads the store.
    await world.compact(ingot, 'notes');
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  it('is dropped before the caller runs anything', async () => {
    expect(await world.sql(ingot, 'SELECT body FROM notes')).toEqual([
      { body: 'in the base tier' },
    ]);
    expect(await world.sql(ingot, 'SELECT name FROM duckdb_secrets()')).toEqual([]);
  });
});
