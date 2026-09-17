import type {
  AccountDetail,
  CastIngotBody,
  IngotSummary,
  MintedKey,
  MintKeyBody,
} from './contract.js';
import { ConfigurationError } from './errors.js';
import { McpConnection, type IngotMcpTool, type McpOptions } from './mcp.js';
import { Ingot } from './ingot.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  INGOT_API_VERSION,
  Transport,
  normaliseUrl,
  segment,
} from './transport.js';

export interface IngotFoundryOptions {
  /** The service root, e.g. `https://ingot.example.com`. Falls back to `INGOT_URL`. */
  readonly url?: string;
  /** The account slug. Falls back to `INGOT_ACCOUNT`. */
  readonly account?: string;
  /** `ing_sk_…`. Falls back to `INGOT_API_KEY`. */
  readonly apiKey?: string;
  /** The `Ingot-Version` to send. Defaults to the release these types describe. */
  readonly version?: string;
  readonly fetch?: FetchLike;
  /** Per attempt. 30 seconds unless given. */
  readonly timeoutMs?: number;
  /** Retries for requests that are safe to repeat, on network errors and 503. 2 unless given. */
  readonly maxRetries?: number;
  /** Sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CastIngotOptions extends CastIngotBody {
  readonly signal?: AbortSignal;
}

export interface VersionsResponse {
  readonly header: string;
  readonly latest: string;
  readonly versions: readonly string[];
  readonly changelog: readonly {
    readonly version: string;
    readonly summary: string;
    readonly changes: readonly string[];
  }[];
}

type Signal = { readonly signal?: AbortSignal };

/** A client for one account on one Ingot deployment. */
export class IngotFoundry {
  /** The account slug every request is made against. */
  readonly accountSlug: string;
  private readonly transport: Transport;

  readonly ingots: {
    /**
     * Casts an ingot. With `externalId`, idempotent: a second cast with the
     * same id answers with the ingot the first one made, unchanged.
     */
    cast(options: CastIngotOptions): Promise<Ingot>;
    list(options?: Signal): Promise<IngotSummary[]>;
    /** Deletes an ingot and everything in it. Not reversible. */
    delete(id: string, options?: Signal): Promise<void>;
  };

  readonly keys: {
    /** The secret is in the response and nowhere else, ever. */
    mint(body?: MintKeyBody & Signal): Promise<MintedKey>;
    revoke(keyId: string, options?: Signal): Promise<void>;
  };

  constructor(options: IngotFoundryOptions = {}) {
    const env = environment();
    const url = options.url ?? env.INGOT_URL;
    const account = options.account ?? env.INGOT_ACCOUNT;
    const apiKey = options.apiKey ?? env.INGOT_API_KEY;

    const missing = [
      url ? null : 'url (INGOT_URL)',
      account ? null : 'account (INGOT_ACCOUNT)',
      apiKey ? null : 'apiKey (INGOT_API_KEY)',
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      throw new ConfigurationError(`Ingot client is missing ${missing.join(', ')}`, {
        code: 'configuration',
      });
    }

    const fetchImpl =
      options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
    if (!fetchImpl) {
      throw new ConfigurationError('No fetch available: pass one as { fetch }', {
        code: 'configuration',
      });
    }

    this.accountSlug = account as string;
    this.transport = new Transport({
      url: normaliseUrl(url as string),
      apiKey: apiKey as string,
      version: options.version ?? INGOT_API_VERSION,
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      headers: options.headers ?? {},
    });

    const accountPath = segment(this.accountSlug);

    this.ingots = {
      cast: async ({ signal, ...body }) => {
        const summary = await this.transport.json<IngotSummary>({
          method: 'POST',
          path: `${accountPath}/cast`,
          json: body,
          // Repeating a create is only harmless when it is keyed.
          safe: body.externalId !== undefined,
          signal,
        });
        return new Ingot(this.transport, this.accountSlug, summary.id, summary);
      },
      list: (options = {}) =>
        this.transport.json<IngotSummary[]>({
          method: 'GET',
          path: `${accountPath}/ingots`,
          safe: true,
          signal: options.signal,
        }),
      delete: async (id, options = {}) => {
        await this.transport.json({
          method: 'DELETE',
          path: `${accountPath}/${segment(id)}`,
          safe: false,
          signal: options.signal,
        });
      },
    };

    this.keys = {
      mint: ({ signal, ...body } = {}) =>
        this.transport.json<MintedKey>({
          method: 'POST',
          path: `accounts/${accountPath}/keys`,
          json: body,
          safe: false,
          signal,
        }),
      revoke: async (keyId, options = {}) => {
        await this.transport.json({
          method: 'DELETE',
          path: `accounts/${accountPath}/keys/${segment(keyId)}`,
          safe: false,
          signal: options.signal,
        });
      },
    };
  }

  /** A handle on an ingot by id. Makes no request. */
  ingot(id: string): Ingot {
    return new Ingot(this.transport, this.accountSlug, id);
  }

  /** The account and its keys. Also the cheapest way to check a key works. */
  account(options: Signal = {}): Promise<AccountDetail> {
    return this.transport.json<AccountDetail>({
      method: 'GET',
      path: `accounts/${segment(this.accountSlug)}`,
      safe: true,
      signal: options.signal,
    });
  }

  /** The API versions the server knows, and what each changed. */
  versions(options: Signal = {}): Promise<VersionsResponse> {
    return this.transport.json<VersionsResponse>({
      method: 'GET',
      path: '/versions',
      safe: true,
      signal: options.signal,
    });
  }

  health(options: Signal = {}): Promise<{ status: string; service: string }> {
    return this.transport.json({
      method: 'GET',
      path: '/health',
      safe: true,
      signal: options.signal,
    });
  }

  /** Account-level tools for an agent: casting, listing and deleting ingots. */
  mcp(options: McpOptions = {}): Promise<IngotMcpTool[]> {
    return new McpConnection(this.transport, `${segment(this.accountSlug)}/mcp`).tools(options);
  }
}

function environment(): Record<
  'INGOT_URL' | 'INGOT_ACCOUNT' | 'INGOT_API_KEY',
  string | undefined
> {
  const read = (name: string): string | undefined => {
    try {
      return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
        ?.env?.[name];
    } catch {
      // Deno without --allow-env throws on the read itself.
      return undefined;
    }
  };
  return {
    INGOT_URL: read('INGOT_URL'),
    INGOT_ACCOUNT: read('INGOT_ACCOUNT'),
    INGOT_API_KEY: read('INGOT_API_KEY'),
  };
}
