import { Guard } from '../shared/domain/index.js';
import { AiProvider } from './providers.js';

/**
 * Which models this deployment thinks with, read once at boot.
 *
 * The same shape as `storage-settings.ts`, for the same reasons: parsed into a
 * discriminated union rather than passed round as a bag of optional strings,
 * so an adapter's constructor cannot be reached without the values it needs;
 * and a pure function over a reader, so the whole matrix is asserted in a unit
 * test rather than by booting the service once per provider and reading a log
 * line.
 *
 * Two selectors rather than one — `INGOT_EMBEDDER` and `INGOT_SUMMARISER` —
 * because they are separate purchases. Semantic search over stored columns is
 * a per-row cost paid once; an LLM-written receipt is a per-call cost paid
 * every time somebody asks for one, and a deployment should be able to have
 * the first without the second.
 */

// ── embedding ───────────────────────────────────────────────────────────────

export type EmbedderSettings = LocalEmbedder | OpenAiEmbedder | GcpEmbedder;

export interface LocalEmbedder {
  readonly provider: AiProvider.Local;
}

export interface OpenAiEmbedder {
  readonly provider: AiProvider.OpenAi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /**
   * Declared, never discovered from a response.
   *
   * The width is baked into every stored vector and into the `FLOAT[N]` column
   * a query session builds, so a model swap that changes it is a re-embed
   * rather than a configuration change — and this is where that becomes
   * obvious. `text-embedding-3-*` honours it as a request parameter, so what
   * is asked for here is what comes back.
   */
  readonly dimensions: number;
  readonly timeoutMs: number;
}

export interface GcpEmbedder {
  readonly provider: AiProvider.Gcp;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  /** As above. Vertex takes it as `outputDimensionality`. */
  readonly dimensions: number;
  /** The Vertex API root. Overridden only for a local stand-in. */
  readonly endpoint?: string;
  readonly timeoutMs: number;
}

// ── summarising ─────────────────────────────────────────────────────────────

export type SummariserSettings = LocalSummariser | OpenAiSummariser | GcpSummariser;

export interface LocalSummariser {
  readonly provider: AiProvider.Local;
}

export interface OpenAiSummariser {
  readonly provider: AiProvider.OpenAi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface GcpSummariser {
  readonly provider: AiProvider.Gcp;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs: number;
}

// ── defaults ────────────────────────────────────────────────────────────────

/**
 * Every default is a *setting*, not a decision this service makes for you.
 *
 * They are named here rather than inline so that the models a deployment gets
 * without configuring anything can be read in one screen — and so that
 * upgrading the default is a one-line change with a test over it.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_SUMMARY_MODEL = 'gpt-4.1-mini';

export const GCP_LOCATION = 'us-central1';
export const GCP_EMBEDDING_MODEL = 'text-embedding-004';
export const GCP_EMBEDDING_DIMENSIONS = 768;
export const GCP_SUMMARY_MODEL = 'gemini-2.5-flash';

/** A model that has not answered in this long is not going to. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The widest vector `FLOAT[N]` is worth building. Guards a typo, not a model. */
const MAX_DIMENSIONS = 8192;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/**
 * A deployment that asked for a model it cannot reach.
 *
 * Fatal, for the reason `StorageMisconfigured` is. A service that boots with a
 * provider named and no key for it either falls back to the stand-in — which
 * silently makes every search lexical — or fails on the first `/add` that
 * wanted a receipt, hours later, to somebody who cannot see the configuration.
 * Refusing to start says it once, to the person holding the deployment.
 */
export class AiMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiMisconfigured';
  }
}

export function embedderSettings(read: Setting): EmbedderSettings {
  return EMBEDDER_PARSERS[provider(read, 'INGOT_EMBEDDER')](read);
}

export function summariserSettings(read: Setting): SummariserSettings {
  return SUMMARISER_PARSERS[provider(read, 'INGOT_SUMMARISER')](read);
}

/** Keyed on the enum, so a provider added without a reader fails to compile. */
const EMBEDDER_PARSERS: Record<AiProvider, (read: Setting) => EmbedderSettings> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (read) => {
    const [apiKey] = demand(read, 'INGOT_EMBEDDER', AiProvider.OpenAi, ['OPENAI_API_KEY']);
    return {
      provider: AiProvider.OpenAi,
      apiKey,
      baseUrl: trimSlash(value(read('OPENAI_BASE_URL')) ?? OPENAI_BASE_URL),
      model: value(read('INGOT_OPENAI_EMBEDDING_MODEL')) ?? OPENAI_EMBEDDING_MODEL,
      dimensions: dimensions(
        read,
        'INGOT_OPENAI_EMBEDDING_DIMENSIONS',
        OPENAI_EMBEDDING_DIMENSIONS,
      ),
      timeoutMs: timeout(read),
    };
  },

  [AiProvider.Gcp]: (read) => {
    const [project] = demand(read, 'INGOT_EMBEDDER', AiProvider.Gcp, ['INGOT_GCP_PROJECT']);
    return {
      provider: AiProvider.Gcp,
      project,
      location: value(read('INGOT_GCP_LOCATION')) ?? GCP_LOCATION,
      model: value(read('INGOT_GCP_EMBEDDING_MODEL')) ?? GCP_EMBEDDING_MODEL,
      dimensions: dimensions(read, 'INGOT_GCP_EMBEDDING_DIMENSIONS', GCP_EMBEDDING_DIMENSIONS),
      endpoint: trimSlashIfSet(value(read('INGOT_GCP_ENDPOINT'))),
      timeoutMs: timeout(read),
    };
  },
};

const SUMMARISER_PARSERS: Record<AiProvider, (read: Setting) => SummariserSettings> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (read) => {
    const [apiKey] = demand(read, 'INGOT_SUMMARISER', AiProvider.OpenAi, ['OPENAI_API_KEY']);
    return {
      provider: AiProvider.OpenAi,
      apiKey,
      baseUrl: trimSlash(value(read('OPENAI_BASE_URL')) ?? OPENAI_BASE_URL),
      model: value(read('INGOT_OPENAI_SUMMARY_MODEL')) ?? OPENAI_SUMMARY_MODEL,
      timeoutMs: timeout(read),
    };
  },

  [AiProvider.Gcp]: (read) => {
    const [project] = demand(read, 'INGOT_SUMMARISER', AiProvider.Gcp, ['INGOT_GCP_PROJECT']);
    return {
      provider: AiProvider.Gcp,
      project,
      location: value(read('INGOT_GCP_LOCATION')) ?? GCP_LOCATION,
      model: value(read('INGOT_GCP_SUMMARY_MODEL')) ?? GCP_SUMMARY_MODEL,
      endpoint: trimSlashIfSet(value(read('INGOT_GCP_ENDPOINT'))),
      timeoutMs: timeout(read),
    };
  },
};

/** The provider a selector names, or the local stand-in when it names none. */
function provider(read: Setting, key: string): AiProvider {
  const named = value(read(key));
  if (named === undefined) return AiProvider.Local;

  try {
    return Guard.oneOf(named.toLowerCase(), Object.values(AiProvider), key);
  } catch {
    throw new AiMisconfigured(
      `${key} is "${named}", which is not a provider this service has. ` +
        `Choose one of: ${Object.values(AiProvider).join(', ')}.`,
    );
  }
}

/**
 * Every value a provider cannot work without, or a message naming the ones
 * that are missing.
 *
 * All of them at once rather than the first: an operator filling in a
 * deployment template should learn what is left in one restart, not in three.
 */
function demand<const K extends readonly string[]>(
  read: Setting,
  selector: string,
  named: AiProvider,
  keys: K,
): { [I in keyof K]: string } {
  const found = keys.map((key) => value(read(key)));
  const missing = keys.filter((_key, at) => found[at] === undefined);

  if (missing.length > 0) {
    throw new AiMisconfigured(
      `${selector}=${named} needs ${keys.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }
  // Every element was just proved present, which is a fact about the loop
  // above rather than one the type of `map` can carry.
  return found as { [I in keyof K]: string };
}

function dimensions(read: Setting, key: string, fallback: number): number {
  const raw = value(read(key));
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DIMENSIONS) {
    throw new AiMisconfigured(
      `${key} is "${raw}"; a vector width is a whole number between 1 and ${MAX_DIMENSIONS}.`,
    );
  }
  return parsed;
}

function timeout(read: Setting): number {
  const raw = value(read('INGOT_AI_TIMEOUT_MS'));
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    throw new AiMisconfigured(
      `INGOT_AI_TIMEOUT_MS is "${raw}"; a timeout is a whole number of milliseconds, ` +
        'and anything under a second is a typo rather than a deadline.',
    );
  }
  return parsed;
}

/** Blank is unset. A variable exported as `""` is one somebody meant to omit. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** So that a base URL with a trailing slash does not produce `//embeddings`. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function trimSlashIfSet(url: string | undefined): string | undefined {
  return url === undefined ? undefined : trimSlash(url);
}
