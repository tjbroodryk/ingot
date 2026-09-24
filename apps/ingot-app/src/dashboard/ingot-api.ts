import type {
  AccountDetail,
  FileBody,
  FileResult,
  IngotInfo,
  IngotSummary,
  QueryResult,
} from '@ingot/shared/ingot-v1';

/** The browser's half of the Ingot API. Types are imported type-only from `@ingot/shared/ingot-v1`. */

/** Where the service is. Inlined at build time (`NEXT_PUBLIC_`); defaults to the local Ingot port. */
export const INGOT_URL = process.env.NEXT_PUBLIC_INGOT_URL ?? 'http://localhost:3002';

/** What the sign-in form collects, and the whole of a session. */
export interface Credentials {
  /** The account slug — the `:account` segment. */
  readonly account: string;
  /** `ing_sk_…`. Sent as a bearer token, never in a URL. */
  readonly key: string;
}

/** A refused request, with the status kept. */
export class IngotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'IngotError';
  }

  /** True when the answer is "not with that key", rather than "not that query". */
  get isCredentialProblem(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Confirms the key works and that it is for this account. */
export function fetchAccount(credentials: Credentials): Promise<AccountDetail> {
  return call<AccountDetail>(credentials, `/api/v1/accounts/${enc(credentials.account)}`);
}

export function listMemories(credentials: Credentials): Promise<readonly IngotSummary[]> {
  return call<readonly IngotSummary[]>(credentials, `/api/v1/${enc(credentials.account)}/ingots`);
}

/** The information schema for one memory, so the console can show what there is to query. */
export function fetchInfo(credentials: Credentials, ingotId: string): Promise<IngotInfo> {
  return call<IngotInfo>(credentials, `/api/v1/${enc(credentials.account)}/${enc(ingotId)}/info`);
}

/** One SELECT against one memory. `ingotId` is the `ing_…` id, not a name. */
export function runQuery(
  credentials: Credentials,
  ingotId: string,
  sql: string,
): Promise<QueryResult> {
  return call<QueryResult>(
    credentials,
    `/api/v1/${enc(credentials.account)}/${enc(ingotId)}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) },
  );
}

/** One document, as multipart, exactly as `/file` wants it. The `body` part is omitted when empty. */
export function uploadFile(
  credentials: Credentials,
  ingotId: string,
  file: File,
  body?: FileBody,
): Promise<FileResult> {
  const form = new FormData();
  form.append('file', file);
  if (body && Object.keys(body).length > 0) form.append('body', JSON.stringify(body));

  return call<FileResult>(
    credentials,
    `/api/v1/${enc(credentials.account)}/${enc(ingotId)}/file`,
    { method: 'POST', body: form },
  );
}

async function call<T>(credentials: Credentials, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${INGOT_URL}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        // Not for a `FormData` body: the browser sets the multipart boundary itself.
        ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${credentials.key}`,
        ...init.headers,
      },
    });
  } catch {
    // A network failure has no status: CORS refusal and unreachable host are the same `TypeError`.
    throw new IngotError(
      0,
      `Could not reach ${INGOT_URL}. Is it running, and does it allow this origin?`,
    );
  }

  if (!response.ok) throw new IngotError(response.status, await messageOf(response));

  return (await response.json()) as T;
}

/** The service's own error message, where it gave one. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0) return body.message;
    if (Array.isArray(body.message)) return body.message.join('; ');
  } catch {
    // No JSON body, or a truncated one. The status line is what is left.
  }

  return `${response.status} ${response.statusText}`;
}

/** Path segments are user input — a slug from a form, an id from a listing. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}
