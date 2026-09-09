import type {
  AccountDetail,
  FileBody,
  FileResult,
  IngotInfo,
  IngotSummary,
  QueryResult,
} from '@ingot/shared/ingot-v1';

/**
 * The browser's half of the Ingot API.
 *
 * Types come from `@ingot/shared/ingot-v1` — the same contract the service
 * compiles against — imported as types only. The package is CommonJS and would
 * not survive a bundle, but nothing here needs a value from it: every one of
 * these is an interface, erased before webpack sees the file.
 *
 * There is no interceptor, no retry and no client-side cache. A dashboard
 * where one person runs one query at a time does not need them, and each would
 * be a place for a failure to be hidden rather than shown.
 */

/**
 * Where the service is.
 *
 * `NEXT_PUBLIC_` because this is a static export: the value is inlined at
 * build time, which is the only way a page with no server can know it. The
 * default is the port `apps/ingot` listens on locally.
 */
export const INGOT_URL = process.env.NEXT_PUBLIC_INGOT_URL ?? 'http://localhost:3002';

/** What the sign-in form collects, and the whole of a session. */
export interface Credentials {
  /** The account slug — the `:account` segment. */
  readonly account: string;
  /** `ing_sk_…`. Sent as a bearer token, never in a URL. */
  readonly key: string;
}

/**
 * A refused request, with the status kept.
 *
 * The status is what decides whether the session is over: a 401 or a 403 means
 * the key will not work again, and the gate should reopen rather than the page
 * showing an error box the user can do nothing about.
 */
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

/** Confirms the key works *and* that it is for this account. Both matter. */
export function fetchAccount(credentials: Credentials): Promise<AccountDetail> {
  return call<AccountDetail>(credentials, `/api/v1/accounts/${enc(credentials.account)}`);
}

export function listMemories(credentials: Credentials): Promise<readonly IngotSummary[]> {
  return call<readonly IngotSummary[]>(credentials, `/api/v1/${enc(credentials.account)}/ingots`);
}

/**
 * The information schema for one memory.
 *
 * Fetched so the console can show what there is to query. Somebody typing SQL
 * against a memory they did not fill has no other way to learn the table names,
 * and guessing them is how you spend a minute reading a "table does not exist"
 * that is really "you spelled it differently".
 */
export function fetchInfo(credentials: Credentials, ingotId: string): Promise<IngotInfo> {
  return call<IngotInfo>(credentials, `/api/v1/${enc(credentials.account)}/${enc(ingotId)}/info`);
}

/**
 * One SELECT against one memory.
 *
 * `ingotId` and not a name: `:ingot` resolves through `IngotId.of`, so the
 * segment is the `ing_…` the memory was created with. The picker shows the
 * name and sends the id, which is the only place that difference should ever
 * have to be thought about.
 */
export function runQuery(
  credentials: Credentials,
  ingotId: string,
  sql: string,
  limit?: number,
): Promise<QueryResult> {
  return call<QueryResult>(
    credentials,
    `/api/v1/${enc(credentials.account)}/${enc(ingotId)}/query`,
    { method: 'POST', body: JSON.stringify({ sql, ...(limit ? { limit } : {}) }) },
  );
}

/**
 * One document, as multipart, exactly as `/file` wants it.
 *
 * The `body` part is the options JSON and is left off entirely when there are
 * none — an empty part would be a second thing the endpoint has to read as
 * "nothing", and the interceptor counts fields.
 */
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
        // Not for a `FormData` body. The boundary is part of the header and
        // only the browser knows it, so setting the type here would send a
        // multipart body multer cannot find the parts in.
        ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${credentials.key}`,
        ...init.headers,
      },
    });
  } catch {
    // A network-level failure has no status, and the browser will not say why
    // — a CORS refusal and an unreachable host are the same `TypeError` here.
    // Naming both is more use than repeating "failed to fetch".
    throw new IngotError(
      0,
      `Could not reach ${INGOT_URL}. Is it running, and does it allow this origin?`,
    );
  }

  if (!response.ok) throw new IngotError(response.status, await messageOf(response));

  return (await response.json()) as T;
}

/**
 * The service's own words, where it gave any.
 *
 * `DomainExceptionFilter` answers `{ statusCode, error, message }`, and that
 * message is written to be read — "more than one statement" is worth showing
 * verbatim where "422 Unprocessable Entity" is not.
 */
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
