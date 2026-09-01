import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  SHAPE_RESOLVER,
  VERSIONING_OPTIONS,
  WireShapeResolver,
  asShapeRef,
  readWire,
  type WireSpec,
} from '@ingot/versioning/nest';
import { AppModule } from '../../src/app.module.js';
import { closeDatabase, openDatabase } from '../support/database.js';
import { INGOT_VERSIONS, VERSION_HEADER } from '../../src/versioning/changeset.js';
import { WireShape } from '../../src/versioning/shapes.js';

/**
 * The versioning contract, held mechanically.
 *
 * Two releases now: the baseline, which transforms nothing, and `2026-08-27`,
 * which renders a table's settings away for a caller from before they existed.
 * That one is asserted directly below rather than only through the invariants —
 * the invariants are traps that arm themselves for the *next* release, and a
 * transform nobody exercises is machinery that can quietly stop working. The
 * engine itself is covered by `@ingot/versioning`'s own suite.
 */

interface Route {
  controller: string;
  handler: string;
  path: string;
  wire: WireSpec | null;
}

async function routes(): Promise<Route[]> {
  const found: Route[] = [];

  for await (const file of new Glob('src/**/*.controller.ts').scan('.')) {
    const module = (await import(`../../${file}`)) as Record<string, unknown>;

    for (const exported of Object.values(module)) {
      if (typeof exported !== 'function' || !exported.prototype) continue;
      const basePath = Reflect.getMetadata(PATH_METADATA, exported) as string | undefined;
      if (basePath === undefined) continue;

      const target = exported as unknown as { name: string; prototype: Record<string, unknown> };
      for (const handler of Object.getOwnPropertyNames(target.prototype)) {
        if (handler === 'constructor') continue;
        const method = target.prototype[handler];
        if (typeof method !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, method) as string | undefined;
        if (path === undefined) continue;

        found.push({
          controller: target.name,
          handler,
          path: `${basePath}/${path}`.replace(/\/+/g, '/'),
          wire: readWire(method),
        });
      }
    }
  }
  return found;
}

describe('every route', () => {
  it('is found at all', async () => {
    expect((await routes()).length).toBeGreaterThan(10);
  });

  /**
   * A route with no `@Wire` is served untransformed whatever version was
   * asked for — silently. That is correct for a health check and wrong for
   * anything carrying the contract, and the difference is invisible until a
   * version ships and one endpoint does not move with it.
   */
  it('says which wire shapes cross it, or says explicitly that none do', async () => {
    const undeclared = (await routes())
      .filter((route) => route.wire === null)
      .map((route) => `${route.controller}.${route.handler} (${route.path})`);

    expect(undeclared).toEqual([]);
  });

  it('names only shapes the contract actually has', async () => {
    const known = new Set<string>(Object.values(WireShape));
    const unknown = (await routes()).flatMap((route) =>
      [asShapeRef(route.wire?.accepts), asShapeRef(route.wire?.returns)]
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
        .filter((ref) => !known.has(ref.shape))
        .map((ref) => `${route.controller}.${route.handler} → ${ref.shape}`),
    );

    expect(unknown).toEqual([]);
  });
});

describe('the shape catalogue', () => {
  it('names only types the wire contract exports', async () => {
    // Types are erased, so this reads the contract's source. Crude, and it
    // catches the thing that actually happens: a shape renamed in the contract
    // and left behind in the enum.
    // Relative to the package root, which is where `bun test` runs — the same
    // convention the other source-reading tests here use. `import.meta` is not
    // available: this package compiles to CommonJS.
    const contract = await Bun.file('../../packages/shared/src/ingot-v1.ts').text();

    const missing = Object.values(WireShape).filter(
      (shape) => !new RegExp(`export (?:interface|type|enum) ${shape}\\b`).test(contract),
    );

    expect(missing).toEqual([]);
  });
});

describe('the changeset', () => {
  it('publishes at least the baseline, and brands its header', () => {
    expect(INGOT_VERSIONS.versions.length).toBeGreaterThan(0);
    expect(VERSION_HEADER).toBe('Ingot-Version');
  });

  it('changes only shapes the catalogue knows', () => {
    const known = new Set<string>(Object.values(WireShape));
    expect(INGOT_VERSIONS.shapes().filter((shape) => !known.has(shape))).toEqual([]);
  });

  /**
   * The trap this file exists for.
   *
   * `QueryResult.rows` holds whatever a caller stored in their own tables, and
   * `AddBody.result` is an arbitrary tool result. A transform that reached into
   * either would corrupt somebody's data in the name of an envelope rename —
   * silently, and for the callers least able to notice.
   *
   * With an empty changeset this passes trivially. It stops being trivial the
   * moment anybody adds a change to those shapes, which is exactly when
   * somebody needs to be told.
   */
  it('never rewrites caller-owned data', () => {
    const rows = [
      { _row_id: 'row_1', total: 5, pending: 2, rows: 'a string called rows' },
      { nested: { rows: 1, items: [{ total: 9 }] } },
    ];
    const result = { columns: ['a'], rows, truncated: false, elapsedMs: 3 };
    const body = {
      table: 't',
      columns: {},
      result: { total: 1, pending: 2, rows: ['anything at all'], items: [{ rows: 3 }] },
    };

    for (const version of INGOT_VERSIONS.versions) {
      const rendered = INGOT_VERSIONS.backward(WireShape.QueryResult, result, version);
      expect((rendered as typeof result).rows).toEqual(rows);

      const migrated = INGOT_VERSIONS.forward(WireShape.AddBody, body, version);
      expect((migrated as typeof body).result).toEqual(body.result);
    }
  });

  /**
   * The first release that does real work, doing it.
   *
   * `config` was added to every `TableInfo` on 2026-08-27. A caller pinned to
   * the baseline was written against a shape with no such field, so it is
   * removed on the way out — and *removed*, not nulled, because a null is
   * still a field. The trap in the other direction is the receipt: `AddResult`
   * carries a `TableInfo` too, and a release that moved one and forgot the
   * other would render two different shapes for the same thing.
   */
  it('renders a table’s settings away for a caller from before they existed', () => {
    const table = { name: 'notes', columns: [], key: [], rows: 1, pending: 0, generation: 0 };
    const config = { fts: { enabled: true, stopwords: 'none' } };

    const info = { id: 'i', name: 'm', tables: [{ ...table, config }] };
    const baseline = INGOT_VERSIONS.backward(WireShape.IngotInfo, info, '2026-08-26') as {
      tables: Record<string, unknown>[];
    };
    expect(baseline.tables[0]).toEqual(table);
    expect(baseline.tables[0]).not.toHaveProperty('config');

    const added = {
      table: 'notes',
      rowsAdded: 1,
      receipt: { batch: 'b', table: { ...table, config } },
    };
    const rendered = INGOT_VERSIONS.backward(WireShape.AddResult, added, '2026-08-26') as {
      receipt: { batch: string; table: Record<string, unknown> };
    };
    expect(rendered.receipt.table).toEqual(table);
    expect(rendered.receipt.batch).toBe('b');

    // The current version is the implemented one and is left exactly as it is.
    expect(INGOT_VERSIONS.backward(WireShape.IngotInfo, info, INGOT_VERSIONS.latest)).toEqual(info);
  });

  it('leaves an AddResult with no receipt alone', () => {
    const added = { table: 'notes', rowsAdded: 1 };
    expect(INGOT_VERSIONS.backward(WireShape.AddResult, added, '2026-08-26')).toEqual(added);
  });

  it('round-trips every shape it touches, at every version', () => {
    // A forward/backward pair that is not the identity is a version that
    // silently rewrites what a caller sent them.
    const fixtures: Partial<Record<string, Record<string, unknown>>> = {
      [WireShape.AddBody]: { table: 't', columns: {}, result: {}, rows: '$.a[*]', raw: true },
      [WireShape.QueryBody]: { sql: 'SELECT 1', limit: 10 },
      [WireShape.DeleteBody]: { table: 't', where: 'true' },
      [WireShape.ConfigureTableBody]: { fts: { enabled: true, stopwords: 'none' } },
    };

    for (const version of INGOT_VERSIONS.versions) {
      for (const shape of INGOT_VERSIONS.shapes()) {
        const fixture = fixtures[shape];
        if (!fixture) continue;
        const up = INGOT_VERSIONS.forward(shape, fixture, version);
        expect(INGOT_VERSIONS.backward(shape, up, version)).toEqual(fixture);
      }
    }
  });
});

describe('the wiring', () => {
  let app: TestingModule;

  beforeAll(async () => {
    const { pool } = await openDatabase();
    process.env.DATABASE_URL ??= (pool.options.connectionString as string) ?? '';
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('binds the changeset and this service’s header', () => {
    const options = app.get(VERSIONING_OPTIONS, { strict: false }) as {
      header: string;
      changeset: typeof INGOT_VERSIONS;
    };
    expect(options.header).toBe(VERSION_HEADER);
    expect(options.changeset.latest).toBe(INGOT_VERSIONS.latest);
  });

  it('resolves shapes from the @Wire decorator this service uses', () => {
    expect(app.get(SHAPE_RESOLVER, { strict: false })).toBeInstanceOf(WireShapeResolver);
  });

  // That the interceptor is bound *globally* is asserted in the package, over
  // the DynamicModule itself — Nest does not expose APP_INTERCEPTOR providers
  // through the container, and the running-server proof lives there too.
});
