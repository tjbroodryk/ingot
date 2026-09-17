import { afterEach, describe, expect, it } from 'bun:test';
import {
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  GoneError,
  INGOT_API_VERSION,
  Ingot,
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

describe('Ingot', () => {
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
      const { ingot, requests } = client(() => json([]), { url });
      await ingot.memories.list();
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
    const ingot = new Ingot({
      fetch: async (url) => {
        seen.push(url);
        return json({ status: 'ok', service: 'ingot' });
      },
    });
    await ingot.health();
    expect(ingot.accountSlug).toBe('from-env');
    expect(seen).toEqual(['https://env.test/api/health']);
  });

  it('refuses to construct without a connection', () => {
    delete process.env.INGOT_URL;
    delete process.env.INGOT_ACCOUNT;
    delete process.env.INGOT_API_KEY;
    expect(() => new Ingot()).toThrow(ConfigurationError);
  });

  it('creates a memory and hands back a handle carrying the summary', async () => {
    const { ingot, requests } = client(() => json(summary, 201));
    const memory = await ingot.memories.create({
      name: 'chat',
      retainFor: '30d',
      externalId: 'chat-1',
    });
    expect(memory.id).toBe('ing_1');
    expect(memory.summary?.externalId).toBe('chat-1');
    expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/create');
    expect(bodyOf(requests[0] as never)).toEqual({
      name: 'chat',
      retainFor: '30d',
      externalId: 'chat-1',
    });
  });

  it('maps the error envelope to a class, keeping the server’s words', async () => {
    const { ingot } = client(() =>
      json({ statusCode: 422, error: 'invariant_violation', message: ['a', 'b'] }, 422),
    );
    const error = await ingot.memories.list().catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('invariant_violation');
    expect(error.message).toBe('a; b');

    const unauthorised = client(() => json({ message: 'no key' }, 401));
    expect(await unauthorised.ingot.account().catch((e) => e)).toBeInstanceOf(AuthenticationError);

    const gone = client(() => new Response('', { status: 410 }));
    expect(
      await gone.ingot
        .memory('ing_1')
        .table('t')
        .parquet()
        .catch((e) => e),
    ).toBeInstanceOf(GoneError);
  });

  it('retries a safe request through 503s and network failures', async () => {
    const { ingot, requests } = client(
      (_request, index) => {
        if (index === 0) return json({ message: 'down' }, 503);
        if (index === 1) throw new TypeError('fetch failed');
        return json([summary]);
      },
      { maxRetries: 2 },
    );
    expect(await ingot.memories.list()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  it('never retries a write that could store twice', async () => {
    const { ingot, requests } = client(() => json({ message: 'down' }, 503), { maxRetries: 3 });
    const memory = ingot.memory('ing_1');
    expect(
      await memory.add({ table: 't', columns: {}, result: {} }).catch((e) => e),
    ).toBeInstanceOf(UnavailableError);
    expect(requests).toHaveLength(1);

    const unkeyed = client(() => {
      throw new TypeError('fetch failed');
    });
    expect(await unkeyed.ingot.memories.create({ name: 'x' }).catch((e) => e)).toBeInstanceOf(
      ConnectionError,
    );
    expect(unkeyed.requests).toHaveLength(1);
  });

  it('retries a keyed create, which the server makes idempotent', async () => {
    const { ingot, requests } = client((_r, index) =>
      index === 0 ? json({ message: 'down' }, 503) : json(summary, 200),
    );
    await ingot.memories.create({ name: 'chat', externalId: 'chat-1' });
    expect(requests).toHaveLength(2);
  });

  it('times out an attempt that never answers', async () => {
    const hanging = new Ingot({
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
    const error = await hanging.memories.list().catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it('manages keys on the account', async () => {
    const { ingot, requests } = client((request) =>
      request.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ id: 'key_1', secret: 's' }, 201),
    );
    await ingot.keys.mint({ label: 'ci' });
    await ingot.keys.revoke('key_1');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://ingot.test/api/v1/accounts/acme/keys',
      'DELETE https://ingot.test/api/v1/accounts/acme/keys/key_1',
    ]);
  });
});
