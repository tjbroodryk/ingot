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

/**
 * Every route in the service, found by reading the decorators off every
 * controller on disk.
 *
 * Deliberately not by booting Nest: whether a route declares an account is a
 * property of the source, and tying the check to a working database and a
 * fully wired module graph would mean it stops protecting anything the first
 * time unrelated infrastructure is mid-change.
 *
 * `AccountScopeGuard` refuses an undeclared route at runtime too. This is the
 * half that fails in CI instead of in production.
 */
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
    // Otherwise an empty glob would make every assertion below vacuous, which
    // is the way a test like this quietly stops testing anything.
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

  /**
   * Unauthenticated routes, listed here so that adding one is a visible edit
   * to a test rather than a decorator nobody reviews.
   *
   * - Account creation, because it is where keys come from and a caller has
   *   none yet.
   * - Health, because a load balancer does not hold credentials.
   * - The version list, because deciding whether to integrate with a service
   *   is something you do before you have a key. It exposes the changelog and
   *   nothing else.
   */
  it('has exactly three open routes, and they are the expected three', async () => {
    const open = (await routes())
      .filter((route) => route.binding?.open === true)
      .map((route) => `${route.controller}.${route.handler}`)
      .sort();

    expect(open).toEqual([
      'AccountsController.create',
      'HealthController.check',
      'VersionsController.list',
    ]);
  });

  it('names a path parameter that its route actually has', async () => {
    const mismatched = (await routes())
      .filter((route) => route.binding !== null && !route.binding.open)
      .filter((route) => !route.path.includes(`:${route.binding?.param}`))
      .map(
        (route) =>
          `${route.controller}.${route.handler} wants :${route.binding?.param} in ${route.path}`,
      );

    // A binding naming a parameter the path does not have is refused at
    // runtime with a 403 — correct, but only discovered by calling it.
    expect(mismatched).toEqual([]);
  });
});

describe('route registration order', () => {
  /**
   * `/:account/:ingot` is as greedy as a pattern gets. Registered before the
   * accounts controller it would swallow `/accounts/acme/keys` and route key
   * management into the memory API — an authenticated caller managing
   * credentials would instead be told there is no ingot called "acme".
   *
   * Two things prevent it, and this asserts the first. The second is
   * `AccountSlug` refusing to mint an account named `accounts`.
   */
  it('puts AccountsModule before the modules with wildcard paths', async () => {
    const source = await Bun.file('src/app.module.ts').text();
    const order = ['AccountsModule', 'IngotsModule', 'RecordsModule', 'QueryModule', 'McpModule'];

    const positions = order.map((name) => ({
      name,
      // The import list, not the import statements at the top.
      at: source.indexOf(`\n    ${name},`),
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
    // The two that matter most, spelled out so a shortened list is noticed.
    expect(RESERVED_SLUGS).toContain('accounts');
    expect(RESERVED_SLUGS).toContain('health');
  });
});
