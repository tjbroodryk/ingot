import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { section, text, whole } from '../config/vars.js';

export const MAX_BODY_KEY = 'INGOT_MAX_BODY_BYTES';

/**
 * The default ceiling on one JSON request body: 16 MiB.
 *
 * Express's own default is 100 KiB, which is a web form's worth and far short
 * of a tool result — a page of search hits or a file listing is past it, and
 * `/add` refused them with a 413 before anything of ours ran. The body is
 * parsed whole into the heap, and `/add` then holds the mapped rows beside it,
 * so like `INGOT_MAX_UPLOAD_BYTES` this is sized against ingot rather than
 * against what a caller might send. Multipart uploads are not governed by it.
 */
export const DEFAULT_MAX_BODY = 16 * 1024 * 1024;

/** Below Express's own default: a cap this small refuses ordinary queries. */
const MIN_MAX_BODY = 100 * 1024;

/** One body past this can take a pod down on its own. A typo guard. */
const MAX_MAX_BODY = 512 * 1024 * 1024;

export interface HttpSettings {
  readonly port: number;
  readonly bodyLimit: number;
  /** Unset allows any origin. */
  readonly corsOrigin?: readonly string[];
}

export const httpEnv = section(
  {
    PORT: whole({ fallback: 3002, min: 1, max: 65_535 }),
    [MAX_BODY_KEY]: whole({
      fallback: DEFAULT_MAX_BODY,
      min: MIN_MAX_BODY,
      max: MAX_MAX_BODY,
      rule: `; it must be a whole number of bytes between ${MIN_MAX_BODY} and ${MAX_MAX_BODY}.`,
    }),
    CORS_ORIGIN: text(),
  },
  (vars): HttpSettings => ({
    port: vars.PORT,
    bodyLimit: vars[MAX_BODY_KEY],
    corsOrigin: vars.CORS_ORIGIN?.split(','),
  }),
);

/**
 * Everything about how the app speaks HTTP, in one place for `main.ts` and for
 * a test that wants a real socket answering the way production does.
 */
export function configureHttp(
  app: NestExpressApplication,
  options: { readonly bodyLimit: number; readonly corsOrigin?: readonly string[] },
): void {
  // Replaces the JSON parser Nest registers, which carries Express's 100 KiB default.
  app.useBodyParser('json', { limit: options.bodyLimit });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors({
    origin: options.corsOrigin ? [...options.corsOrigin] : true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
