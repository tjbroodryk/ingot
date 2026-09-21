import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { aiEnv } from '../ai/ai-settings.js';
import { authEnv } from '../auth/auth-settings.js';
import { filesEnv } from '../contexts/files/application/file-settings.js';
import { concurrencyEnv } from '../contexts/records/application/background-settings.js';
import { generationGraceEnv } from '../contexts/records/application/generation-grace.js';
import { databaseEnv } from '../database/database-settings.js';
import { deliveryEnv } from '../delivery/delivery-settings.js';
import { engineEnv, parquetCacheEnv } from '../engine/engine-settings.js';
import { httpEnv } from '../http/body-limit.js';
import { telemetryEnv } from '../observability/config.js';
import { storageEnv } from '../storage/storage-settings.js';
import type { Section } from './vars.js';

/**
 * Every variable this service reads, grouped by what reads it.
 *
 * Each section is declared beside the code it configures, so the defaults and
 * the reasons for them stay where somebody changing that code will see them.
 * This is only the list.
 */
const SECTIONS = {
  auth: authEnv,
  http: httpEnv,
  database: databaseEnv,
  storage: storageEnv,
  engine: engineEnv,
  parquetCache: parquetCacheEnv,
  ai: aiEnv,
  delivery: deliveryEnv,
  files: filesEnv,
  concurrency: concurrencyEnv,
  generationGraceMs: generationGraceEnv,
  telemetry: telemetryEnv,
};

export type Env = { readonly [K in keyof typeof SECTIONS]: z.output<(typeof SECTIONS)[K]> };

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * A deployment configured wrongly, with everything that is wrong with it.
 *
 * Fatal at boot, before anything is listening. Every section is parsed even
 * after one fails, so an operator filling in a deployment template learns
 * what is left in one restart rather than in one per mistake.
 */
export class EnvMisconfigured extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      problems.length === 1
        ? (problems[0] as string)
        : `The environment has ${problems.length} problems:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    this.name = 'EnvMisconfigured';
  }
}

/** The whole environment, parsed once. `main.ts` calls this before building anything. */
export function loadEnv(source: EnvSource = process.env): Env {
  const resolved = withSecretFiles(source, Object.values(SECTIONS));
  const env: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, schema] of Object.entries(SECTIONS)) {
    const parsed = (schema as Section).safeParse(resolved);
    if (parsed.success) env[name] = parsed.data;
    else problems.push(...describe(parsed.error, resolved));
  }

  if (problems.length > 0) throw new EnvMisconfigured([...new Set(problems)]);
  return env as Env;
}

/** One section on its own — for a test that asserts one area's matrix. */
export function loadSection<T>(schema: Section<T>, source: EnvSource): T {
  const resolved = withSecretFiles(source, [schema]);
  const parsed = schema.safeParse(resolved);
  if (!parsed.success) throw new EnvMisconfigured(describe(parsed.error, resolved));
  return parsed.data;
}

/**
 * `NAME_FILE` for any declared `NAME` that is not set directly.
 *
 * `INGOT_API_KEY_FILE=/run/secrets/ingot-key` is the Docker and Kubernetes
 * convention for a secret that should not be an environment variable —
 * `/proc/<pid>/environ`, a crash dump and anything that logs the environment
 * all read those, and a mounted file is none of those things. Only declared
 * names, so an unrelated `SSL_CERT_FILE` in the process is left alone.
 */
function withSecretFiles(source: EnvSource, sections: readonly Section[]): EnvSource {
  const resolved: Record<string, string | undefined> = { ...source };

  for (const section of sections) {
    for (const key of Object.keys(section.in.shape)) {
      const path = source[`${key}_FILE`]?.trim();
      if (path === undefined || path === '' || (source[key]?.trim() ?? '') !== '') continue;

      try {
        resolved[key] = readFileSync(path, 'utf8');
      } catch (error) {
        throw new EnvMisconfigured([
          `${key}_FILE points at ${path}, which could not be read: ${String(error)}`,
        ]);
      }
    }
  }
  return resolved;
}

/**
 * A clause about a value — one starting `;` or `,` — gets `NAME is "value"`
 * in front of it. See `vars.ts` for why the two kinds exist.
 */
function describe(error: z.ZodError, source: EnvSource): string[] {
  return error.issues.map((issue) => {
    const key = issue.path[0];
    const raw = typeof key === 'string' ? source[key]?.trim() : undefined;
    return /^[;,]/.test(issue.message) && raw !== undefined
      ? `${String(key)} is "${raw}"${issue.message}`
      : issue.message;
  });
}
