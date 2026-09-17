import {
  ConnectionError,
  IngotError,
  TimeoutError,
  UnavailableError,
  errorFromResponse,
} from './errors.js';
import { INGOT_API_VERSION, SDK_VERSION } from './version.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TransportSettings {
  /** The service root, already normalised: no trailing `/` or `/api`. */
  readonly url: string;
  readonly apiKey: string;
  readonly version: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /**
   * Relative to `/api/v1/`, already encoded. A leading `/` addresses `/api`
   * itself, for the version-neutral routes.
   */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly json?: unknown;
  readonly form?: FormData;
  /**
   * Whether sending this twice is harmless. Only safe requests are retried:
   * `/add` has no deduplication, and a retried one can store its rows twice.
   */
  readonly safe: boolean;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 5_000;

export class Transport {
  constructor(readonly settings: TransportSettings) {}

  /** Parsed JSON, or `undefined` for an empty body (204). */
  async json<T>(spec: RequestSpec): Promise<T> {
    return this.send(spec, async (response) => {
      const text = await response.text();
      return (text.length === 0 ? undefined : JSON.parse(text)) as T;
    });
  }

  /** The response itself, status and headers untouched, once it is known to be ok. */
  async response(spec: RequestSpec): Promise<Response> {
    return this.send(spec, async (response) => response, { keepAliveAfterHeaders: true });
  }

  private async send<T>(
    spec: RequestSpec,
    read: (response: Response) => Promise<T>,
    options: { keepAliveAfterHeaders?: boolean } = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(spec, read, options);
      } catch (error) {
        if (!spec.safe || attempt >= this.settings.maxRetries || !retryable(error)) throw error;
        attempt += 1;
        await sleep(backoff(attempt, error), spec.signal);
      }
    }
  }

  private async once<T>(
    spec: RequestSpec,
    read: (response: Response) => Promise<T>,
    options: { keepAliveAfterHeaders?: boolean },
  ): Promise<T> {
    const deadline = withDeadline(this.settings.timeoutMs, spec.signal);
    let released = false;
    const release = () => {
      if (!released) deadline.release();
      released = true;
    };

    try {
      let response: Response;
      try {
        response = await this.settings.fetch(this.urlFor(spec), {
          method: spec.method,
          headers: this.headersFor(spec),
          body: spec.form ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json)),
          signal: deadline.signal,
        });
      } catch (error) {
        throw deadline.explain(error, `${spec.method} ${spec.path}`);
      }

      if (!response.ok) {
        throw errorFromResponse(response.status, response.statusText, await bodyOf(response));
      }

      if (options.keepAliveAfterHeaders) {
        // A streamed body outlives this call. Holding the timer over it would
        // cut a large download off at `timeoutMs`; the caller's own signal
        // stays attached so it can still abort the stream.
        deadline.detachTimer();
        released = true;
        return await read(response);
      }

      try {
        return await read(response);
      } catch (error) {
        throw deadline.explain(error, `${spec.method} ${spec.path}`);
      }
    } finally {
      release();
    }
  }

  private urlFor(spec: RequestSpec): string {
    const base = spec.path.startsWith('/')
      ? `${this.settings.url}/api${spec.path}`
      : `${this.settings.url}/api/v1/${spec.path}`;
    const params = Object.entries(spec.query ?? {}).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (params.length === 0) return base;
    return `${base}?${new URLSearchParams(params.map(([key, value]) => [key, String(value)]))}`;
  }

  private headersFor(spec: RequestSpec): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.settings.apiKey}`,
      'ingot-version': this.settings.version,
      'x-ingot-sdk': `ts/${SDK_VERSION}`,
      // Never for FormData: the boundary is part of the header and only the
      // runtime building the body knows it.
      ...(spec.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...this.settings.headers,
      ...spec.headers,
    };
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export { INGOT_API_VERSION };

/** `https://x/api/`, `https://x/api/v1` and `https://x/` all mean `https://x`. */
export function normaliseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/api(\/v1)?$/, '');
  return url;
}

export function segment(value: string): string {
  return encodeURIComponent(value);
}

function retryable(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    error instanceof TimeoutError ||
    error instanceof UnavailableError
  );
}

function backoff(attempt: number, error: unknown): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  return error instanceof UnavailableError ? Math.max(jittered, RETRY_BASE_MS) : jittered;
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A timeout and the caller's signal as one signal.
 *
 * `AbortSignal.any` and `AbortSignal.timeout` would do this, and Node 18 has
 * neither the first nor a way to tell the two causes apart afterwards.
 */
function withDeadline(timeoutMs: number, outer: AbortSignal | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener('abort', onOuterAbort, { once: true });

  return {
    signal: controller.signal,
    detachTimer() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    release() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      outer?.removeEventListener('abort', onOuterAbort);
    },
    explain(error: unknown, what: string): unknown {
      if (error instanceof IngotError) return error;
      if (outer?.aborted) return outer.reason ?? error;
      if (timedOut) {
        return new TimeoutError(`${what} did not answer within ${timeoutMs}ms`, {
          code: 'timeout',
          cause: error,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      return new ConnectionError(`${what} failed before a response: ${detail}`, {
        code: 'connection',
        cause: error,
      });
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
