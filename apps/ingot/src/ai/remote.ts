import { APICallError } from 'ai';
import { upstream, type Recording } from '../observability/index.js';

/**
 * One call to somebody else's model, measured and bounded.
 *
 * Shared by every remote adapter so that the things which are true of every
 * hosted model are true once: a deadline, a single retry, and a failure that
 * says which host and which status rather than `fetch failed`.
 *
 * Two shapes reach it. The embedders hand over a URL and a body and this file
 * does the `fetch` — there is no library worth the dependency for two JSON
 * endpoints. The summariser hands over a thunk that runs inside the AI SDK,
 * which does its own HTTP and would do its own retries if `maxRetries` were
 * not set to zero. `retryOnce` is what both go through, so the policy below is
 * one policy and not two that drift.
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
  return retryOnce(call.host, call.operation, (span) => {
    span.set({ 'ai.url': call.url });
    return once<T>(call);
  });
}

/**
 * The policy, with the transport left to the caller.
 *
 * `work` is run, and run a second time if the first attempt failed in a way a
 * second could plausibly fix. That is the whole of it — see the note at the
 * top of this file for why it is one retry and not a ladder.
 */
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
 *
 * `RemoteModelError` is this file's own; `APICallError` is what the AI SDK
 * throws, and it carries the same three facts under different names. Its
 * `isRetryable` is deliberately not consulted — it treats every 5xx as
 * transient, including the two that mean "this API does not have that",
 * and the set at the top of this file is the one this service has decided on.
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
async function pause(header: string | null | undefined): Promise<void> {
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
