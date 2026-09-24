import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * Two layers guard `POST /query`: the session lockdown and the statement check
 * that refuses anything but a single SELECT. Both are needed — the lockdown
 * does not stop `ATTACH ':memory:'` (see the ATTACH case below).
 */
describe('the query sandbox', () => {
  let world: World;
  let ingot: string;

  beforeAll(async () => {
    world = await makeWorld();
    ingot = await world.ingot('a memory to attack');
    await world.add(ingot, {
      table: 'notes',
      columns: { body: { from: '$.body', type: ColumnType.Varchar } },
      result: { body: 'nothing secret' },
    });
  });

  afterAll(async () => {
    await world?.close();
    await closeDatabase();
  });

  // Each is a way out of the session: filesystem, network, another tenant's
  // data, the configuration, or more memory than allowed.
  const attacks: ReadonlyArray<readonly [string, string]> = [
    ['writing a file', `COPY (SELECT 1) TO '/tmp/ingot-escaped.csv'`],
    ['reading a local file', `SELECT * FROM read_csv('/etc/passwd')`],
    [
      "reading another tenant's parquet",
      `SELECT * FROM read_parquet('/tmp/somebody-else.parquet')`,
    ],
    ['reaching the network', `SELECT * FROM read_csv('https://example.com/exfiltrate.csv')`],
    ['installing an extension', 'INSTALL spatial'],
    ['loading an extension', 'LOAD spatial'],
    ['attaching a database file', `ATTACH 'smuggled.db' AS other`],
    // The one the lockdown misses; only the statement check refuses it.
    ['attaching memory', `ATTACH ':memory:' AS smuggled`],
    ['detaching', 'DETACH notes'],
    ['restoring external access', 'SET enable_external_access = true'],
    ['releasing the lock', 'SET lock_configuration = false'],
    ['raising its own memory limit', "SET memory_limit = '64GB'"],
    ['creating a table', 'CREATE TABLE trespass AS SELECT 1'],
    ['dropping one', 'DROP TABLE notes'],
    ['deleting rows', 'DELETE FROM notes'],
    ['updating rows', "UPDATE notes SET body = 'tampered'"],
    ['inserting rows', "INSERT INTO notes VALUES ('forged')"],
    ['a pragma', 'PRAGMA database_list'],
    // Reachable because every session loads `fts`; index building goes through
    // /config, not a query.
    ['building an index of its own', "PRAGMA create_fts_index('notes', '_row_id', 'body')"],
    ['calling a table function', 'CALL pragma_version()'],
    ['chaining a second statement', 'SELECT 1; DROP TABLE notes'],
    ['hiding one behind a comment', 'SELECT 1; -- DROP TABLE notes\nDROP TABLE notes'],
    ['exporting the database', `EXPORT DATABASE '/tmp/ingot-dump'`],
  ];

  it.each(attacks)('refuses %s', async (_label, sql) => {
    await expect(world.query(ingot, { sql })).rejects.toThrow();
  });

  it('says why, in terms a caller can act on', async () => {
    await expect(world.query(ingot, { sql: 'DROP TABLE notes' })).rejects.toThrow(
      /must begin with SELECT/,
    );
    await expect(world.query(ingot, { sql: 'SELECT 1; SELECT 2' })).rejects.toThrow(
      /Send one statement/,
    );
    // Reaches the type check, not the shape check: it reads as a SELECT until parsed.
    await expect(
      world.query(ingot, { sql: `SELECT * FROM read_csv('/etc/passwd')` }),
    ).rejects.toThrow(/file system operations are disabled|Permission/i);
  });

  it('leaves the data intact after every one of them', async () => {
    const result = await world.query(ingot, { sql: 'SELECT body FROM notes' });
    expect(result.rows).toEqual([{ body: 'nothing secret' }]);
  });

  it('still answers an ordinary query', async () => {
    const result = await world.query(ingot, {
      sql: "SELECT upper(body) AS shouted FROM notes WHERE body LIKE 'nothing%'",
    });
    expect(result.rows).toEqual([{ shouted: 'NOTHING SECRET' }]);
  });

  it('allows the read-only things a caller legitimately wants', async () => {
    // The check is on statement type, not keywords, so CTEs and
    // information_schema reads pass.
    const cte = await world.query(ingot, {
      sql: 'WITH counted AS (SELECT count(*) AS n FROM notes) SELECT n FROM counted',
    });
    expect(Number(cte.rows[0]?.n)).toBe(1);

    const schema = await world.query(ingot, {
      sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 'notes'",
    });
    expect(schema.rows.map((row) => row.column_name)).toContain('body');
  });

  describe('the delete predicate', () => {
    // /delete wraps a predicate in a SELECT, so a predicate must not be able to
    // close it and start another statement.
    it('refuses a predicate that closes the statement', async () => {
      await expect(world.forget(ingot, 'notes', '1=1); DROP TABLE notes; --')).rejects.toThrow();
    });

    it('refuses a predicate that comments the rest away', async () => {
      await expect(world.forget(ingot, 'notes', '1=1) UNION SELECT 1 --')).rejects.toThrow();
    });

    it('still deletes what an honest predicate names', async () => {
      expect(await world.forget(ingot, 'notes', "body = 'no such row'")).toBe(0);
    });
  });
});
