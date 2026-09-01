/**
 * The parts of the page that are not an endpoint: what a reader needs before
 * the first route makes sense, and what every route can answer with.
 */

/** One of the three ruled cells under the page head. */
export interface Basic {
  /** The anchor, where the sidebar links to one. */
  readonly id?: string;
  readonly kicker: string;
  readonly title: string;
  /** Backticks render as code. */
  readonly body: string;
  readonly sample: string;
}

export const BASICS: readonly Basic[] = [
  {
    id: 'base',
    kicker: 'Base URL',
    title: 'URI versioning',
    body: 'The origin is wherever you run Ingot — it is self-hosted, so the samples here use the port it listens on locally. Everything is under `/api/v1`; `/api/health` and `/api/versions` are version-neutral, so neither moves when the contract does.',
    sample: `http://localhost:3002
  /api/v1/:account/:ingot`,
  },
  {
    id: 'auth',
    kicker: 'Auth',
    title: 'One bearer key',
    body: 'Required everywhere except health, versions and sign-up. Only a SHA-256 digest of a key is stored, so a secret is shown once and never again.',
    sample: `Authorization:
  Bearer ing_sk_…`,
  },
  {
    kicker: 'Shape',
    title: 'JSON in, JSON out',
    body: 'Two POSTs read rather than write — `/query` and `/delete` — because both carry a body, and a body on a GET or a DELETE is a thing intermediaries drop.',
    sample: `Content-Type:
  application/json
Ingot-Version: 2026-08-27`,
  },
];

export const QUICKSTART = `# 1 — sign up; the secret comes back exactly once
curl -X POST http://localhost:3002/api/v1/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"slug":"acme","name":"Acme Inc"}'

# 2 — cast a memory; keep the id, it is the next path segment
curl -X POST http://localhost:3002/api/v1/acme/create \\
  -H "Authorization: Bearer ing_sk_…" \\
  -d '{"name":"crm-notes","retainFor":"14d"}'

# 3 — read it back, the same second
curl -X POST http://localhost:3002/api/v1/acme/ing_01H8Z…/query \\
  -H "Authorization: Bearer ing_sk_…" \\
  -d '{"sql":"SELECT company, arr FROM contacts"}'`;

export interface StatusCode {
  readonly code: string;
  /** Backticks render as code. */
  readonly when: string;
}

/**
 * What the service answers with, read off `DomainExceptionFilter` rather than
 * off a convention — which is why 400 and 422 are two rows. A body that is not
 * the right *kind* of thing is refused by the validation pipe; a body that is
 * well formed and does not make sense is refused by the domain, and those are
 * different answers to different mistakes.
 */
export const STATUS_CODES: readonly StatusCode[] = [
  {
    code: '200',
    when: 'Read succeeded — including the POSTs that change nothing, and the patch that returns the whole object.',
  },
  { code: '201', when: 'Something was created: an account, a key, a memory, a row.' },
  { code: '204', when: 'Something was removed: a key, a table, a memory.' },
  {
    code: '400',
    when: 'The body is not the right shape — an unknown field, a `retainFor` that is not a number and a unit.',
  },
  { code: '401', when: 'No key, an unknown key, or one that has been revoked.' },
  { code: '403', when: 'The key is valid, but not for the account named in the path.' },
  { code: '404', when: 'No such account, memory or table.' },
  { code: '409', when: 'The write conflicts with what is already there — a slug or a name taken.' },
  {
    code: '422',
    when: 'Well formed and refused: more than one statement in `sql`, a column type that will not hold the value, a predicate that gets out of its brackets.',
  },
  {
    code: '503',
    when: 'Nothing is wrong with the request. Something this service depends on would not play its part.',
  },
];
