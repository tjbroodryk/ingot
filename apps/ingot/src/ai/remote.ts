import { upstream } from '../observability/index.js';

/**
 * One call to somebody else's model, measured and bounded.
 *
 * Shared by all four remote adapters so that the things which are true of
 * every hosted model are true once: a deadline, a single retry, and a failure
 * that says which host and which status rather than `fetch failed`.
 *
 * **One retry, not a backoff ladder.** Both callers of this run inside a
 * command, and a command runs inside a Postgres transaction — so every second
 * spent sleeping here is a connection held out of a pool of ten. There is
 * already a durable retry a layer up: the embedding and receipt sweepers tick
 * again shortly, and work left in a queue is work that gets done. So this
 * absorbs the blip that a second attempt fixes and hands everything else back,
 * rather than turning a rate limit into a stalled pool.
 *
 * `host` is a metric label, so it is a code constant — `openai`, `vertex` —
 * and never a URL. Per-request detail belongs on the span, where it is free.
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

/**
 * A model that answered with something other than success.
 *
 * Carries the status so a caller can tell "your key is wrong" — which no
 * number of retries will fix — from "try again shortly".
 */
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
  return upstream(call.host, call.operation, async (span) => {
    span.set({ 'ai.url': call.url });

    try {
      return await once<T>(call);
    } catch (error) {
      if (!(error instanceof RemoteModelError) || !error.transient) throw error;

      span.set({ 'ai.retried': true, 'ai.first_status': error.status });
      await pause(error);
      return once<T>(call);
    }
  });
}

async function once<T>(call: RemoteCall): Promise<T> {
  // `AbortSignal.timeout` rather than a manual timer: it cancels the socket
  // rather than merely abandoning the promise, so a model that never answers
  // does not hold a connection open behind our back.
  const response = await fetch(call.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...call.headers },
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(call.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new RemoteModelError(call.host, response.status, clip(detail));
    // Threaded through so the retry can honour it, rather than read twice.
    retryAfter.set(error, response.headers.get('retry-after'));
    throw error;
  }

  return (await response.json()) as T;
}

/**
 * `Retry-After` when the host named one and it is short, a fixed pause
 * otherwise. Anything longer is an outage rather than a wait, and waiting for
 * it inside a transaction is the wrong place to find that out.
 */
async function pause(error: RemoteModelError): Promise<void> {
  const header = retryAfter.get(error);
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  const wanted = Number.isFinite(seconds) ? seconds * 1_000 : 250;

  await new Promise((resolve) => setTimeout(resolve, Math.min(wanted, MAX_RETRY_WAIT_MS)));
}

/**
 * The header, kept beside the error rather than on it.
 *
 * A `WeakMap` because `RemoteModelError` is thrown out of this module and into
 * handlers, and a retry hint is a detail of how this file retries — not part
 * of what an adapter's caller is told went wrong.
 */
const retryAfter = new WeakMap<RemoteModelError, string | null>();

function clip(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_ERROR_CHARS ? flat : `${flat.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
