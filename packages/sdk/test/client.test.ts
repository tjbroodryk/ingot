import { afterEach, describe, expect, it } from 'bun:test';
import {
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  GoneError,
  INGOT_API_VERSION,
  IngotFoundry,
  TimeoutError,
  UnavailableError,
  ValidationError,
} from '../src/index.js';
import { bodyOf, client, json } from './support.js';

const summary = {
  id: 'ing_1',
  name: 'chat',
  externalId: 'chat-1',
  tables: 0,
  rows: 0,
  createdAt: '2026-09-17T00:00:00.000Z',
  expiresAt: null,
};

describe('IngotFoundry', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('addresses /api/v1 however the url was written, with auth and a pinned version', async () => {
    for (const url of [
      'https://ingot.test',
      'https://ingot.test/',
      'https://ingot.test/api',
      'https://ingot.test/api/v1/',
    ]) {
      const { foundry, requests } = client(() => json([]), { url });
      await foundry.ingots.list();
      expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/ingots');
      expect(requests[0]?.headers.authorization).toBe('Bearer ing_sk_test');
      expect(requests[0]?.headers['ingot-version']).toBe(INGOT_API_VERSION);
    }
  });

  it('reads its connection from the environment', async () => {
    process.env.INGOT_URL = 'https://env.test';
    process.env.INGOT_ACCOUNT = 'from-env';
    process.env.INGOT_API_KEY = 'ing_sk_env';
    const seen: string[] = [];
    const foundry = new IngotFoundry({
      fetch: async (url) => {
        seen.push(url);
        return json({ status: 'ok', service: 'ingot' });
      },
    });
    await foundry.health();
    expect(foundry.accountSlug).toBe('from-env');
    expect(seen).toEqual(['https://env.test/api/health']);
  });

  it('refuses to construct without a connection', () => {
    delete process.env.INGOT_URL;
    delete process.env.INGOT_ACCOUNT;
    delete process.env.INGOT_API_KEY;
    expect(() => new IngotFoundry()).toThrow(ConfigurationError);
  });

  it('casts an ingot and hands back a handle carrying the summary', async () => {
    const { foundry, requests } = client(() => json(summary, 201));
    const ingot = await foundry.ingots.cast({
      name: 'chat',
      retainFor: '30d',
      externalId: 'chat-1',
    });
    expect(ingot.id).toBe('ing_1');
    expect(ingot.summary?.externalId).toBe('chat-1');
    expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/cast');
    expect(bodyOf(requests[0] as never)).toEqual({
      name: 'chat',
      retainFor: '30d',
      externalId: 'chat-1',
    });
  });

  it('maps the error envelope to a class, keeping the server’s words', async () => {
    const { foundry } = client(() =>
      json({ statusCode: 422, error: 'invariant_violation', message: ['a', 'b'] }, 422),
    );
    const error = await foundry.ingots.list().catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('invariant_violation');
    expect(error.message).toBe('a; b');

    const unauthorised = client(() => json({ message: 'no key' }, 401));
    expect(await unauthorised.foundry.account().catch((e) => e)).toBeInstanceOf(
      AuthenticationError,
    );

    const gone = client(() => new Response('', { status: 410 }));
    expect(
      await gone.foundry
        .ingot('ing_1')
        .table('t')
        .parquet()
        .catch((e) => e),
    ).toBeInstanceOf(GoneError);
  });

  it('retries a safe request through 503s and network failures', async () => {
    const { foundry, requests } = client(
      (_request, index) => {
        if (index === 0) return json({ message: 'down' }, 503);
        if (index === 1) throw new TypeError('fetch failed');
        return json([summary]);
      },
      { maxRetries: 2 },
    );
    expect(await foundry.ingots.list()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  it('never retries a write that could store twice', async () => {
    const { foundry, requests } = client(() => json({ message: 'down' }, 503), { maxRetries: 3 });
    const ingot = foundry.ingot('ing_1');
    expect(await ingot.add({ table: 't', columns: {}, result: {} }).catch((e) => e)).toBeInstanceOf(
      UnavailableError,
    );
    expect(requests).toHaveLength(1);

    const unkeyed = client(() => {
      throw new TypeError('fetch failed');
    });
    expect(await unkeyed.foundry.ingots.cast({ name: 'x' }).catch((e) => e)).toBeInstanceOf(
      ConnectionError,
    );
    expect(unkeyed.requests).toHaveLength(1);
  });

  it('retries a keyed create, which the server makes idempotent', async () => {
    const { foundry, requests } = client((_r, index) =>
      index === 0 ? json({ message: 'down' }, 503) : json(summary, 200),
    );
    await foundry.ingots.cast({ name: 'chat', externalId: 'chat-1' });
    expect(requests).toHaveLength(2);
  });

  it('times out an attempt that never answers', async () => {
    const hanging = new IngotFoundry({
      url: 'https://ingot.test',
      account: 'acme',
      apiKey: 'k',
      timeoutMs: 20,
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const error = await hanging.ingots.list().catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it('manages keys on the account', async () => {
    const { foundry, requests } = client((request) =>
      request.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ id: 'key_1', secret: 's' }, 201),
    );
    await foundry.keys.mint({ label: 'ci' });
    await foundry.keys.revoke('key_1');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://ingot.test/api/v1/accounts/acme/keys',
      'DELETE https://ingot.test/api/v1/accounts/acme/keys/key_1',
    ]);
  });
});
