import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Body, Controller, Get, type INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsOptional, IsString } from 'class-validator';
import { Changeset, type Release } from '../src/index.js';
import { VersioningModule, Wire } from '../src/nest/index.js';

/**
 * The interceptor, through a real Nest app over a real socket.
 *
 * The engine's tests cover the transformations as pure functions; these cover
 * the things only a running pipeline can answer — that the request is migrated
 * *before* the ValidationPipe sees it, that the response is rendered after the
 * handler, and that the header is negotiated at all.
 *
 * The ordering claim is the one worth a server: the pipe is configured with
 * `forbidNonWhitelisted`, so an old-shaped body reaching it untransformed is
 * rejected with a 400 rather than quietly accepted. If the interceptor ran in
 * the wrong place, every old-version request would fail — and no unit test of
 * the interceptor in isolation would show it.
 */
const RELEASES: readonly Release[] = [
  { version: '2026-01-01', summary: 'The first published shape.', changes: [] },
  {
    version: '2026-02-01',
    summary: 'Renamed a request field and nested a response count.',
    changes: [
      {
        shape: 'Note',
        note: '`text` became `body`.',
        forward: ({ text, ...rest }) =>
          text === undefined ? { ...rest } : { ...rest, body: text },
        backward: ({ body, ...rest }) =>
          body === undefined ? { ...rest } : { ...rest, text: body },
      },
      {
        shape: 'Counted',
        note: '`total` and `pending` moved under `rows`.',
        backward: (value) => {
          const rows = value.rows as { total: number; pending: number };
          const { rows: _dropped, ...rest } = value;
          return { ...rest, total: rows.total, pending: rows.pending };
        },
      },
    ],
  },
];

class NoteDto {
  /** Only the *current* name exists here. That is the whole point. */
  @IsString()
  body!: string;

  @IsOptional()
  @IsString()
  tag?: string;
}

@Controller('notes')
class NotesController {
  @Post()
  @Wire({ accepts: 'Note', returns: 'Note' })
  create(@Body() note: NoteDto): { body: string; tag?: string } {
    return { body: note.body.toUpperCase(), ...(note.tag ? { tag: note.tag } : {}) };
  }

  @Get('counted')
  @Wire({ returns: 'Counted' })
  counted(): { name: string; rows: { total: number; pending: number } } {
    return { name: 'notes', rows: { total: 40, pending: 3 } };
  }

  @Get('many')
  @Wire({ returns: { shape: 'Counted', array: true } })
  many(): { name: string; rows: { total: number; pending: number } }[] {
    return [
      { name: 'a', rows: { total: 1, pending: 0 } },
      { name: 'b', rows: { total: 2, pending: 1 } },
    ];
  }

  @Get('page')
  @Wire({ returns: { shape: 'Counted', paged: true } })
  page(): { items: unknown[]; nextCursor: string | null } {
    return { items: [{ name: 'a', rows: { total: 1, pending: 0 } }], nextCursor: null };
  }

  /** Declares nothing, so nothing is transformed — the health-check case. */
  @Get('raw')
  raw(): { total: number } {
    return { total: 1 };
  }
}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const { Module } = await import('@nestjs/common');
  @Module({
    imports: [
      VersioningModule.forRoot({
        changeset: new Changeset(RELEASES),
        header: 'Test-Version',
      }),
    ],
    controllers: [NotesController],
  })
  class TestModule {}

  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
});

async function call(
  path: string,
  options: { version?: string; body?: unknown } = {},
): Promise<{ status: number; header: string | null; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.version ? { 'Test-Version': options.version } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    header: response.headers.get('test-version'),
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe('negotiating a version', () => {
  it('serves the newest when no header is sent, and says so', async () => {
    const answered = await call('/notes/counted');
    expect(answered.header).toBe('2026-02-01');
    expect(answered.json).toEqual({ name: 'notes', rows: { total: 40, pending: 3 } });
  });

  it('echoes the version it served', async () => {
    expect((await call('/notes/counted', { version: '2026-01-01' })).header).toBe('2026-01-01');
  });

  it('refuses a version it has never published, and lists the ones it has', async () => {
    const refused = await call('/notes/counted', { version: '2025-12-31' });
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toContain('2026-02-01');
  });

  it('ignores an empty header rather than refusing it', async () => {
    expect((await call('/notes/counted', { version: '   ' })).status).toBe(200);
  });
});

describe('a request from an older caller', () => {
  it('is migrated before the ValidationPipe binds it', async () => {
    // `text` is not a field on NoteDto, and the pipe forbids unknown ones. A
    // 201 here is the proof that the interceptor ran first.
    const answered = await call('/notes', { version: '2026-01-01', body: { text: 'hello' } });

    expect(answered.status).toBe(201);
    expect(answered.json).toEqual({ text: 'HELLO' });
  });

  it('is rejected on the current version, because the field no longer exists', async () => {
    const refused = await call('/notes', { version: '2026-02-01', body: { text: 'hello' } });
    expect(refused.status).toBe(400);
  });

  it('round-trips a field the change did not touch', async () => {
    const answered = await call('/notes', {
      version: '2026-01-01',
      body: { text: 'hi', tag: 'x' },
    });
    expect(answered.json).toEqual({ text: 'HI', tag: 'x' });
  });
});

describe('a response to an older caller', () => {
  it('is rendered back down', async () => {
    expect((await call('/notes/counted', { version: '2026-01-01' })).json).toEqual({
      name: 'notes',
      total: 40,
      pending: 3,
    });
  });

  it('transforms each element of a list', async () => {
    const answered = await fetch(`${base}/notes/many`, {
      headers: { 'Test-Version': '2026-01-01' },
    });
    expect(await answered.json()).toEqual([
      { name: 'a', total: 1, pending: 0 },
      { name: 'b', total: 2, pending: 1 },
    ]);
  });

  it('reaches inside a page without transforming the wrapper', async () => {
    const answered = await call('/notes/page', { version: '2026-01-01' });
    expect(answered.json).toEqual({
      items: [{ name: 'a', total: 1, pending: 0 }],
      nextCursor: null,
    });
  });

  it('leaves a route that declares no shape alone', async () => {
    const answered = await call('/notes/raw', { version: '2026-01-01' });
    expect(answered.json).toEqual({ total: 1 });
    // Still negotiated, still echoed — only the body is untouched.
    expect(answered.header).toBe('2026-01-01');
  });
});

describe('what the module registers', () => {
  /**
   * Asserted on the DynamicModule rather than through a running container,
   * because Nest does not expose `APP_INTERCEPTOR` providers through `get`.
   *
   * Registered-but-not-global is a failure with no symptom: every response
   * would simply lack the header and no transform would ever run, on every
   * endpoint, silently. The tests above prove that a module wired this way
   * does intercept; this one proves it is wired this way.
   */
  it('binds the interceptor under APP_INTERCEPTOR', async () => {
    const { APP_INTERCEPTOR } = await import('@nestjs/core');
    const { VersionInterceptor } = await import('../src/nest/version.interceptor.js');
    const { SHAPE_RESOLVER, WireShapeResolver } = await import('../src/nest/shape-resolver.js');

    const module = VersioningModule.forRoot({
      changeset: new Changeset(RELEASES),
      header: 'Test-Version',
    });
    const providers = (module.providers ?? []) as Record<string, unknown>[];

    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: VersionInterceptor,
    });
    // And the default resolver, for a service that has not supplied one.
    expect(providers).toContainEqual({
      provide: SHAPE_RESOLVER,
      useClass: WireShapeResolver,
    });
  });

  it('takes a service’s own resolver when it has one', async () => {
    const { SHAPE_RESOLVER } = await import('../src/nest/shape-resolver.js');
    class Custom {
      accepts() {
        return null;
      }
      returns() {
        return null;
      }
    }

    const module = VersioningModule.forRoot({
      changeset: new Changeset(RELEASES),
      header: 'Test-Version',
      resolver: Custom,
    });

    expect((module.providers ?? []) as unknown[]).toContainEqual({
      provide: SHAPE_RESOLVER,
      useClass: Custom,
    });
  });
});
