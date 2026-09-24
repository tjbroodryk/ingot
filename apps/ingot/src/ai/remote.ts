import { APICallError } from 'ai';
import { upstream, type Recording } from '../observability/index.js';

/**
 * One call to a remote model, measured and bounded: a deadline, a single
 * retry, and a failure naming the host and status. `host` is a metric label,
 * so a code constant (`openai`, `vertex`), never a URL.
 */
export interface RemoteCall {
  readonly host: string;
  readonly operation: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly timeoutMs: number;
}

/** Retried once: a rate limit, and the transient half of the 5xx range. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** A `Retry-After` longer than this is not a wait, it is an outage. */
const MAX_RETRY_WAIT_MS = 2_000;

/** How much of an error body is worth putting in a log line. */
const MAX_ERROR_CHARS = 500;

/** A non-success response from a model. Carries the status to tell fatal from transient. */
export class RemoteModelError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${host} answered ${status}: ${detail}`);
    this.name = 'RemoteModelError';
  }

  /** Whether a later attempt could plausibly succeed. */
  get transient(): boolean {
    return RETRYABLE.has(this.status);
  }
}

export async function callModel<T>(call: RemoteCall): Promise<T> {
  return retryOnce(call.host, call.operation, (span) => {
    span.set({ 'ai.url': call.url });
    return once<T>(call);
  });
}

/** Runs `work`, once more if the first attempt failed transiently. Transport is the caller's. */
export async function retryOnce<T>(
  host: string,
  operation: string,
  work: (span: Recording) => Promise<T>,
): Promise<T> {
  return upstream(host, operation, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      const failure = transience(error);
      if (!failure.transient) throw error;

      span.set({ 'ai.retried': true, 'ai.first_status': failure.status ?? 0 });
      await pause(failure.retryAfter);
      return work(span);
    }
  });
}

/**
 * Whether a later attempt could plausibly succeed, from either transport.
 * The SDK's own `isRetryable` is not used: it treats every 5xx as transient.
 */
function transience(error: unknown): {
  transient: boolean;
  status?: number;
  retryAfter?: string | null;
} {
  if (error instanceof RemoteModelError) {
    return { transient: error.transient, status: error.status, retryAfter: retryAfter.get(error) };
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    return {
      transient: status !== undefined && RETRYABLE.has(status),
      status,
      retryAfter: error.responseHeaders?.['retry-after'] ?? null,
    };
  }
  return { transient: false };
}

async function once<T>(call: RemoteCall): Promise<T> {
  // `AbortSignal.timeout` cancels the socket, so a model that never answers frees the connection.
  const response = await fetch(call.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...call.headers },
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(call.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new RemoteModelError(call.host, response.status, clip(detail));
    // Kept beside the error so the retry can honour it without reading the body twice.
    retryAfter.set(error, response.headers.get('retry-after'));
    throw error;
  }

  return (await response.json()) as T;
}

/** `Retry-After` when short, a fixed pause otherwise; anything longer is capped as an outage. */
async function pause(header: string | null | undefined): Promise<void> {
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  const wanted = Number.isFinite(seconds) ? seconds * 1_000 : 250;

  await new Promise((resolve) => setTimeout(resolve, Math.min(wanted, MAX_RETRY_WAIT_MS)));
}

/** `Retry-After` kept off the error itself, since it is internal to this file's retry. */
const retryAfter = new WeakMap<RemoteModelError, string | null>();

function clip(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_ERROR_CHARS ? flat : `${flat.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
