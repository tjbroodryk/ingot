import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { closeDatabase } from '../support/database.js';
import { type World, makeWorld } from '../support/world.js';

/**
 * The most important test in this service.
 *
 * `POST /query` takes SQL from whoever holds an API key and runs it. Two
 * layers stand between that and the machine, and both are here:
 *
 *  - the session lockdown (`enable_external_access = false`,
 *    `lock_configuration = true`), which stops anything reaching the
 *    filesystem, the network, or another tenant's Parquet; and
 *  - the statement check (`extractStatements` + `prepare().statementType`),
 *    which refuses anything that is not exactly one SELECT.
 *
 * The second is not a second opinion. Phase 0 established that the lockdown
 * does **not** contain `ATTACH ':memory:'` — it touches no filesystem and no
 * network, so nothing refuses it, and once attached a caller can allocate
 * freely. The statement check is what stops that, which makes it load bearing.
 * Anyone tempted to delete it as redundant should read the ATTACH case below.
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

  // Each of these is a way out of the session: onto the filesystem, onto the
  // network, into another tenant's data, into the configuration, or into more
  // memory than the caller is entitled to.
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
    // The one the lockdown misses. See the note on this describe block.
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
    // Every session loads `fts`, so this one is reachable in a way the others
    // are not — and it builds tables over a whole column. Search is asked for
    // through /config, which decides what it costs; not through a query.
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
    // Which layer answers depends on the attack, and both messages say the
    // same thing in the caller's terms rather than the engine's.
    await expect(world.query(ingot, { sql: 'DROP TABLE notes' })).rejects.toThrow(
      /must begin with SELECT/,
    );
    await expect(world.query(ingot, { sql: 'SELECT 1; SELECT 2' })).rejects.toThrow(
      /Send one statement/,
    );
    // Reaches the type check rather than the shape check: it is written as a
    // select and only the parse tree knows better.
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
    // A WITH clause, a window function and an information_schema read are all
    // SELECTs. Refusing them would make the endpoint useless for the thing it
    // exists for, so the check is on statement *type*, not on keywords.
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
    // /delete takes a predicate, not a statement — it is wrapped in a SELECT
    // this service writes. That wrapping is only true if a predicate cannot
    // close it and start something else, which is what these check.
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
