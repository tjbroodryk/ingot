import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  ACCOUNT_BINDING,
  type AccountBinding,
} from '../../src/contexts/accounts/interface/account.decorator.js';

interface Route {
  controller: string;
  handler: string;
  path: string;
  binding: AccountBinding | null;
}

/** Every route in the service, read from the decorators on each controller on disk. */
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

        // Only route handlers carry a path; skip ordinary helpers.
        const path = Reflect.getMetadata(PATH_METADATA, method) as string | undefined;
        if (path === undefined) continue;

        found.push({
          controller: target.name,
          handler,
          path: `${basePath}/${path}`.replace(/\/+/g, '/'),
          binding:
            (Reflect.getMetadata(ACCOUNT_BINDING, method) as AccountBinding | undefined) ??
            (Reflect.getMetadata(ACCOUNT_BINDING, exported) as AccountBinding | undefined) ??
            null,
        });
      }
    }
  }

  return found;
}

describe('every route', () => {
  it('finds the controllers at all', async () => {
    // Guards against an empty glob making every assertion below vacuous.
    const found = await routes();
    expect(found.length).toBeGreaterThan(10);
    expect(new Set(found.map((route) => route.controller)).size).toBeGreaterThan(3);
  });

  it('declares the account it is scoped to', async () => {
    const undeclared = (await routes())
      .filter((route) => route.binding === null)
      .map((route) => `${route.controller}.${route.handler} (${route.path})`);

    expect(undeclared).toEqual([]);
  });

  // The two unauthenticated routes (health check, version list), listed so
  // adding one is a visible test edit. Neither writes.
  it('has exactly two open routes, and neither of them writes', async () => {
    const open = (await routes())
      .filter((route) => route.binding?.open === true)
      .map((route) => `${route.controller}.${route.handler}`)
      .sort();

    expect(open).toEqual(['HealthController.check', 'VersionsController.list']);
  });

  it('names a path parameter that its route actually has', async () => {
    const mismatched = (await routes())
      .filter((route) => route.binding !== null && !route.binding.open)
      .filter((route) => !route.path.includes(`:${route.binding?.param}`))
      .map(
        (route) =>
          `${route.controller}.${route.handler} wants :${route.binding?.param} in ${route.path}`,
      );

    expect(mismatched).toEqual([]);
  });
});

describe('route registration order', () => {
  // The wildcard `/:account/:ingot` would swallow `/accounts/...` if registered
  // first, so `AccountsModule` must come before it.
  it('puts AccountsModule before the modules with wildcard paths', async () => {
    const source = await Bun.file('src/app.module.ts').text();
    const order = ['AccountsModule', 'IngotsModule', 'RecordsModule', 'QueryModule', 'McpModule'];

    const positions = order.map((name) => ({
      name,
      // Matches the bare entry in the import list, by shape rather than a fixed indent.
      at: source.search(new RegExp(`^\\s+${name},$`, 'm')),
    }));

    for (const entry of positions) expect(entry.at).toBeGreaterThan(-1);

    const accounts = positions[0]?.at as number;
    for (const later of positions.slice(1)) {
      expect(later.at).toBeGreaterThan(accounts);
    }
  });

  it('refuses to mint an account that would shadow a route', async () => {
    const { AccountSlug, RESERVED_SLUGS } =
      await import('../../src/contexts/accounts/domain/account-slug.vo.js');

    for (const reserved of RESERVED_SLUGS) {
      expect(() => AccountSlug.of(reserved)).toThrow(/reserved/);
    }
    // Spelled out so a shortened list is noticed.
    expect(RESERVED_SLUGS).toContain('accounts');
    expect(RESERVED_SLUGS).toContain('health');
  });
});
