import { Ingot, type IngotOptions } from '../src/index.js';

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | null | undefined;
}

type Responder = (request: Recorded, index: number) => Response | Promise<Response>;

/** A fetch that records every request and answers from a script. */
export function fakeFetch(responder: Responder) {
  const requests: Recorded[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const request: Recorded = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    };
    requests.push(request);
    if (init.signal?.aborted) throw init.signal.reason;
    return responder(request, requests.length - 1);
  };
  return { fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function client(responder: Responder, options: IngotOptions = {}) {
  const fake = fakeFetch(responder);
  const ingot = new Ingot({
    url: 'https://ingot.test',
    account: 'acme',
    apiKey: 'ing_sk_test',
    fetch: fake.fetch,
    ...options,
  });
  return { ingot, requests: fake.requests };
}

export function bodyOf(request: Recorded): unknown {
  return JSON.parse(String(request.body));
}
