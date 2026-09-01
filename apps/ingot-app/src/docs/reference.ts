/**
 * The Ingot HTTP surface, as a document.
 *
 * Written down rather than generated, and that is a decision with a shelf
 * life. `apps/api` serves a `GET /api/v1/docs` assembled off the running
 * container, so its reference cannot describe a route that is not there;
 * `apps/ingot` has no such route yet, and half of what a reader needs here —
 * the quickstart, why a POST reads rather than writes, which of two spellings
 * of a delete is the one intermediaries keep — is prose no builder produces.
 *
 * So: this file is the copy, and it stays the copy. When ingot grows the
 * reference endpoint, the *inventory* — method, path, auth, status — comes
 * from there and these entries keep the prose, the same way `@Doc` sits beside
 * the discovered route rather than repeating it. Until then
 * `test/reference.test.ts` is what stops the two drifting.
 *
 * Every sample below is checked against `@ingot/shared/ingot-v1` and the DTOs
 * under `apps/ingot/src/contexts/`. A reference that invents a field name is
 * worse than no reference, because it is believed.
 */

/** How a route is reached. `All` is MCP, which is JSON-RPC over one path. */
export enum HttpMethod {
  Get = 'GET',
  Post = 'POST',
  Delete = 'DELETE',
  All = 'ALL',
}

/** Whether a key is needed. Three routes say `Open`, and they are the reason. */
export enum Auth {
  Open = 'open',
  Key = 'key',
}

/** The sections of the reference, in the order they are read. */
export enum EndpointGroup {
  Service = 'service',
  Accounts = 'accounts',
  Memories = 'memories',
  Data = 'data',
  Mcp = 'mcp',
}

/** A sample sits on stock, or is set into ink where it is somebody's config. */
export enum SampleTone {
  Paper = 'paper',
  Ink = 'ink',
}

export interface GroupHeading {
  /** What the section rule says. */
  readonly title: string;
  /** What the sidebar calls it. */
  readonly nav: string;
}

/** One named field of a request body, for the routes that have several. */
export interface BodyField {
  readonly name: string;
  readonly doc: string;
}

export interface Endpoint {
  /** The anchor, and the key the sidebar links on. */
  readonly id: string;
  readonly group: EndpointGroup;
  /** What the sidebar calls it — shorter than the summary, longer than the path. */
  readonly nav: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: Auth;
  /** The sentence under the path. Backticks render as code. */
  readonly summary: string;
  /** A second paragraph, where one sentence will not carry it. */
  readonly note?: string;
  /** Small bordered labels under the prose — durations, tool names. */
  readonly chips?: readonly string[];
  /** Rendered as a two-column table under the prose. */
  readonly fields?: readonly BodyField[];
  /** The example. Omitted only where `asideChips` takes the column instead. */
  readonly sample?: string;
  readonly sampleTone?: SampleTone;
  /** Fills the example column with labels, for a route whose answer is a tool list. */
  readonly asideChips?: readonly string[];
}

export const GROUPS: Record<EndpointGroup, GroupHeading> = {
  [EndpointGroup.Service]: { title: 'Service · version-neutral', nav: 'Service' },
  [EndpointGroup.Accounts]: { title: 'Accounts & keys', nav: 'Accounts & keys' },
  [EndpointGroup.Memories]: { title: 'Memories', nav: 'Memories' },
  [EndpointGroup.Data]: { title: 'Data', nav: 'Data' },
  [EndpointGroup.Mcp]: { title: 'MCP over streamable HTTP', nav: 'MCP' },
};

/** The order the groups are rendered and navigated in. */
export const GROUP_ORDER: readonly EndpointGroup[] = [
  EndpointGroup.Service,
  EndpointGroup.Accounts,
  EndpointGroup.Memories,
  EndpointGroup.Data,
  EndpointGroup.Mcp,
];

export const ENDPOINTS: readonly Endpoint[] = [
  // ── service ─────────────────────────────────────────────────────────────
  {
    id: 'health',
    group: EndpointGroup.Service,
    nav: '/api/health',
    method: HttpMethod.Get,
    path: '/api/health',
    auth: Auth.Open,
    summary:
      'Liveness. Version-neutral so a load balancer never has to be updated when the contract is.',
    sample: `200 OK
{ "status": "ok", "service": "ingot" }`,
  },
  {
    id: 'versions',
    group: EndpointGroup.Service,
    nav: '/api/versions',
    method: HttpMethod.Get,
    path: '/api/versions',
    auth: Auth.Open,
    summary:
      'The changelog of the wire contract: the header name, the latest release, every version, and what each one changed.',
    note: 'Public, because deciding whether to integrate with a service is something you do before you have a key.',
    sample: `200 OK
{ "header": "Ingot-Version",
  "latest": "2026-08-27",
  "versions": ["2026-08-26", "2026-08-27"],
  "changelog": [
    { "version": "2026-08-27",
      "summary": "…",
      "changes": ["…"] } ] }`,
  },

  // ── accounts ────────────────────────────────────────────────────────────
  {
    id: 'account-create',
    group: EndpointGroup.Accounts,
    nav: 'Create account',
    method: HttpMethod.Post,
    path: '/api/v1/accounts',
    auth: Auth.Open,
    summary:
      'Sign-up. The only route on the service that needs no key, because it is where keys come from — the response carries a usable secret exactly once.',
    sample: `{ "slug": "acme", "name": "Acme Inc" }

201 Created
{ "account": { "slug": "acme", "name": "Acme Inc" },
  "key": { "id": "key_01H…",
           "prefix": "ing_sk_7f2c…",
           "secret": "ing_sk_…" } }
# store it now — only a digest is kept`,
  },
  {
    id: 'account-detail',
    group: EndpointGroup.Accounts,
    nav: 'Account detail',
    method: HttpMethod.Get,
    path: '/api/v1/accounts/:account',
    auth: Auth.Key,
    summary:
      'The account and the keys on it — metadata only. `prefix` is the non-secret head of a key, which is what tells two of them apart.',
    sample: `200 OK
{ "slug": "acme", "name": "Acme Inc",
  "keys": [{ "id": "key_01H…",
             "label": "ci",
             "prefix": "ing_sk_7f2c…",
             "lastUsedAt": "2026-08-27T09:14:02Z",
             "revokedAt": null }] }`,
  },
  {
    id: 'key-mint',
    group: EndpointGroup.Accounts,
    nav: 'Mint a key',
    method: HttpMethod.Post,
    path: '/api/v1/accounts/:account/keys',
    auth: Auth.Key,
    summary: 'Mint another key with a label. The secret is returned once, and only once.',
    sample: `{ "label": "staging-agent" }

201 Created
{ "id": "key_01J…", "label": "staging-agent",
  "prefix": "ing_sk_91ab…",
  "secret": "ing_sk_…" }`,
  },
  {
    id: 'key-revoke',
    group: EndpointGroup.Accounts,
    nav: 'Revoke a key',
    method: HttpMethod.Delete,
    path: '/api/v1/accounts/:account/keys/:keyId',
    auth: Auth.Key,
    summary: 'Revoke a key. It stops authenticating on the next request.',
    sample: '204 No Content',
  },

  // ── memories ────────────────────────────────────────────────────────────
  {
    id: 'ingot-create',
    group: EndpointGroup.Memories,
    nav: 'Cast a memory',
    method: HttpMethod.Post,
    path: '/api/v1/:account/create',
    auth: Auth.Key,
    summary:
      'Cast a new ingot — one memory. Takes a `name` and an optional `retainFor`: a duration, because the question you are asking is "how long".',
    note: 'Expiry deletes the memory and everything in it, and that is not reversible. Omit it and the memory is kept until something deletes it. Keep the `id` it hands back: that is the `:ingot` segment on every route below — a memory is addressed by id, never by name.',
    chips: ['30m', '12h', '14d', '4w'],
    sample: `{ "name": "crm-notes",
  "retainFor": "14d" }

201 Created
{ "id": "ing_01H8Z…", "name": "crm-notes",
  "tables": 0, "rows": 0,
  "expiresAt": "2026-09-10T11:02:00Z" }`,
  },
  {
    id: 'ingot-list',
    group: EndpointGroup.Memories,
    nav: 'List memories',
    method: HttpMethod.Get,
    path: '/api/v1/:account/ingots',
    auth: Auth.Key,
    summary:
      "The account's memories, as an array. A literal segment, registered before the `:ingot` routes so a listing is not read as a memory called “ingots”.",
    note: 'This is how you get an `id` back if you did not keep the one `create` handed you.',
    sample: `200 OK
[ { "id": "ing_01H8Z…", "name": "crm-notes",
    "tables": 3, "rows": 412,
    "expiresAt": "2026-09-10T…" },
  { "id": "ing_01J2Q…", "name": "session-42",
    "tables": 1, "rows": 18,
    "expiresAt": null } ]`,
  },
  {
    id: 'ingot-info',
    group: EndpointGroup.Memories,
    nav: 'Schema · /info',
    method: HttpMethod.Get,
    path: '/api/v1/:account/:ingot/info',
    auth: Auth.Key,
    summary: 'The information schema — what a model reads before it writes SQL.',
    note: 'Answered entirely from Postgres: no bucket read, no DuckDB session. `pending` is the rows still in the overlay, which a query already sees.',
    sample: `200 OK
{ "name": "crm-notes",
  "embedding": { "model": "text-embedding-3-small",
                 "dimensions": 1536 },
  "tables": [{
    "name": "contacts",
    "rows": 412, "pending": 27, "generation": 9,
    "key": ["id"],
    "columns": [
      { "name": "company", "type": "VARCHAR",
        "embedded": false, "required": true },
      { "name": "arr", "type": "DOUBLE",
        "embedded": false, "required": true } ] }] }`,
  },
  {
    id: 'table-config',
    group: EndpointGroup.Memories,
    nav: 'Configure a table',
    method: HttpMethod.Post,
    path: '/api/v1/:account/:ingot/config/:table',
    auth: Auth.Key,
    summary:
      'How a table is read, not what is in it: the stemmer, the stopwords, which columns are indexed, what is stripped before tokenising.',
    note: 'A patch, so sending one setting leaves the other six alone — and the whole `TableConfig` comes back, defaults included, because a caller who changed one field otherwise has no way to see the rest.',
    sample: `{ "fts": { "stemmer": "english",
          "stopwords": "none",
          "ignore": "[^a-z0-9]+",
          "columns": ["body"] } }

200 OK
{ "fts": { "enabled": true, "stemmer": "english",
           "stopwords": "none",
           "ignore": "[^a-z0-9]+",
           "stripAccents": true, "lowercase": true,
           "columns": ["body"] } }`,
  },
  {
    id: 'table-drop',
    group: EndpointGroup.Memories,
    nav: 'Drop a table',
    method: HttpMethod.Delete,
    path: '/api/v1/:account/:ingot/tables/:table',
    auth: Auth.Key,
    summary: 'Drop one table from the memory, its Parquet and its overlay rows with it.',
    sample: '204 No Content',
  },
  {
    id: 'ingot-destroy',
    group: EndpointGroup.Memories,
    nav: 'Destroy a memory',
    method: HttpMethod.Delete,
    path: '/api/v1/:account/:ingot',
    auth: Auth.Key,
    summary: 'Destroy the memory and everything in it.',
    sample: '204 No Content',
  },

  // ── data ────────────────────────────────────────────────────────────────
  {
    id: 'add',
    group: EndpointGroup.Data,
    nav: 'Store a result',
    method: HttpMethod.Post,
    path: '/api/v1/:account/:ingot/add',
    auth: Auth.Key,
    summary:
      'Store a tool result. It lands in the Postgres overlay, so it is queryable the moment this returns — nothing waits on a Parquet file being rewritten.',
    fields: [
      { name: 'columns', doc: 'Maps JSON paths onto typed columns. A path or a constant, never both.' },
      { name: 'rows', doc: 'Selects an array to fan out into one row each. Omitted, the blob is one row.' },
      { name: 'key', doc: 'What identifies a row, so a receipt can hand back SQL that still finds it next week.' },
      { name: 'receipt', doc: '`none`, `schema` or `full`. The rungs escalate, and so does what each costs.' },
      { name: 'result', doc: 'The tool result itself. Anything JSON, `null` included.' },
    ],
    sample: `{ "table": "contacts",
  "rows": "$.contacts[*]",
  "columns": {
    "id":      { "from": "$.id",       "type": "VARCHAR" },
    "company": { "from": "$.org.name", "type": "VARCHAR" },
    "arr":     { "from": "$.deal.arr", "type": "DOUBLE" },
    "notes":   { "from": "$.notes",    "type": "VARCHAR",
                 "embed": true } },
  "key": ["id"],
  "receipt": "schema",
  "result": toolResult }

201 Created
{ "table": "contacts", "rowsAdded": 412,
  "columnsAdded": ["notes"],
  "queuedForEmbedding": 412,
  "payload": { "kilobytes": 84.2,
               "estimatedTokens": 21507 } }`,
  },
  {
    id: 'query',
    group: EndpointGroup.Data,
    nav: 'Query',
    method: HttpMethod.Post,
    path: '/api/v1/:account/:ingot/query',
    auth: Auth.Key,
    summary:
      'Read it back. `sql` is run as written — exactly one SELECT, in a locked-down DuckDB session, over a view unioning the overlay with the Parquet base. `text` is embedded and ranks a table by similarity.',
    note: 'Given both, the embedding is bound as `$q` and your SQL may use it, which is how a hybrid search is one round trip rather than two. A POST that changes nothing, hence the explicit 200.',
    sample: `# structured
{ "sql": "SELECT company, arr FROM contacts
          WHERE stage = 'won' ORDER BY arr DESC" }

# or in words
{ "text": "renewal risk in EMEA",
  "table": "notes", "column": "body" }

200 OK
{ "columns": ["company", "arr"],
  "rows": [ { "company": "Northwind", "arr": 84000 } ],
  "truncated": false, "elapsedMs": 34 }`,
  },
  {
    id: 'delete',
    group: EndpointGroup.Data,
    nav: 'Forget rows',
    method: HttpMethod.Post,
    path: '/api/v1/:account/:ingot/delete',
    auth: Auth.Key,
    summary:
      'Forget the rows matching a `where` predicate. It is resolved to row ids and those are written as tombstones, so a later query filters against a finite set rather than a growing list of predicates.',
    note: 'A POST rather than a DELETE because it carries a body, and a body on a DELETE is a thing intermediaries drop.',
    sample: `{ "table": "contacts",
  "where": "stage = 'lost'" }

200 OK
{ "table": "contacts", "rowsForgotten": 17,
  "truncated": false }`,
  },

  // ── mcp ─────────────────────────────────────────────────────────────────
  {
    id: 'mcp-account',
    group: EndpointGroup.Mcp,
    nav: 'Account-wide',
    method: HttpMethod.All,
    path: '/api/v1/:account/mcp',
    auth: Auth.Key,
    summary:
      'Account-wide MCP, for a client that has not been handed a memory yet. Cast one, then reconnect to the scoped path below.',
    asideChips: ['create_memory', 'list_memories', 'delete_memory'],
  },
  {
    id: 'mcp-ingot',
    group: EndpointGroup.Mcp,
    nav: 'Scoped to a memory',
    method: HttpMethod.All,
    path: '/api/v1/:account/:ingot/mcp',
    auth: Auth.Key,
    summary:
      'MCP scoped to one memory: the tools take no ids and cannot reach another. Stateless — a fresh server per request, no session pinned to a replica.',
    note: 'The same bearer key and the same two guards as every other route; there is no MCP-specific auth path, which is the point. The schema is handed over as the server’s instructions at `initialize`, so writing SQL costs no tool call.',
    chips: [
      'describe',
      'remember',
      'query',
      'recall',
      'forget',
      'configure_table',
      'drop_table',
    ],
    sampleTone: SampleTone.Ink,
    sample: `# claude_desktop_config.json
{ "mcpServers": { "ingot": {
    "url": "https://api.ingot.dev/api/v1/
           acme/ing_01H8Z…/mcp",
    "headers": { "Authorization":
      "Bearer ing_sk_…" } } } }`,
  },
];

/** The endpoints of one group, in declaration order. */
export function endpointsIn(group: EndpointGroup): readonly Endpoint[] {
  return ENDPOINTS.filter((endpoint) => endpoint.group === group);
}
