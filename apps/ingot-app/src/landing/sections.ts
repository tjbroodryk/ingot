/**
 * What the landing page says, as data.
 *
 * The same argument `src/docs/page-sections.ts` makes: the copy is the thing
 * that gets edited, and it is easier to read and to change when it is not
 * interleaved with the markup that lays it out.
 *
 * Every sample here is a real request against the shapes in
 * `@ingot/shared/ingot-v1`, checked the same way the reference's are — the
 * canvas design this page is drawn from had two of them wrong, and both
 * mistakes are the kind a reader would only find by being lied to:
 *
 *   - `:ingot` is the `ing_…` id `create` hands back, never the memory's name.
 *   - `/add` takes its blob as `result`, and `columns` maps to
 *     `{ from, type }` objects rather than to bare path strings.
 *
 * The addresses are `localhost:3002` rather than a hosted API, because that is
 * the only address Ingot has: it is self-hosted, and a landing page that
 * advertises a service you cannot reach is the first of those lies.
 */

/** One of the three numbered cells under "How it works". */
export interface Step {
  readonly n: string;
  readonly title: string;
  readonly body: string;
  /** The route the step is, printed under it. */
  readonly route: string;
}

export const STEPS: readonly Step[] = [
  {
    n: '01',
    title: 'Cast a memory',
    body: 'One POST names an ingot and sets how long it lives — 30m for a session, 4w for a project. Keep the id it hands back.',
    route: 'POST /:account/create',
  },
  {
    n: '02',
    title: 'Store tool results',
    body: 'Map JSON paths onto typed columns, fan an array into rows, set identity for upserts, opt into a receipt diff.',
    route: 'POST /:account/:ingot/add',
  },
  {
    n: '03',
    title: 'Query or recall',
    body: 'Exactly one SELECT against sandboxed DuckDB — the overlay unioned with Parquet — or ask for it in words.',
    route: 'POST /:account/:ingot/query',
  },
];

/** One cell of the six under "What you get". */
export interface Feature {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
}

export const FEATURES: readonly Feature[] = [
  {
    kicker: 'Typed',
    title: 'Columns, not blobs',
    body: 'JSON paths map onto real types, so a model can filter and aggregate instead of re-reading text.',
  },
  {
    kicker: 'Schema first',
    title: '/info costs nothing',
    body: 'Answered straight out of Postgres — no bucket read, no DuckDB session. Cheap enough to call every turn.',
  },
  {
    kicker: 'Sandboxed',
    title: 'Exactly one SELECT',
    body: 'Queries run in a locked-down DuckDB that unions the live overlay with Parquet. Nothing else gets through.',
  },
  {
    kicker: 'Retention',
    title: '30m to 4w, per memory',
    body: 'Scratch memory for a session, durable memory for a project. Set it once, when the memory is cast.',
  },
  {
    kicker: 'Search',
    title: 'Keyword and semantic',
    body: 'Full-text with a configurable stemmer and stopwords, or semantic recall scoped to a table and a column.',
  },
  {
    kicker: 'Keys',
    title: 'One bearer token',
    body: 'Mint and revoke labelled keys. A secret is returned exactly once — MCP included, which has no separate auth path.',
  },
];

/** The row under the hero. What the thing already speaks, rather than logos. */
export const SPEAKS: readonly string[] = [
  'MCP',
  'DuckDB',
  'Parquet',
  'Postgres',
  'HTTP/JSON',
  'SQL',
];

/** The left half of the terminal: a tool result going in. */
export const REMEMBER = `# 1 — remember a tool result
POST /api/v1/acme/ing_01H8Z…/add
{
  "table": "contacts",
  "rows": "$.contacts[*]",
  "columns": {
    "id":      { "from": "$.id",
                 "type": "VARCHAR" },
    "company": { "from": "$.org.name",
                 "type": "VARCHAR" },
    "arr":     { "from": "$.deal.arr",
                 "type": "DOUBLE" } },
  "key": ["id"],
  "result": toolResult
}

201 Created · rowsAdded 412`;

/**
 * The right half: the same rows coming back, in the same second.
 *
 * The artboard drew the result as a box-drawn table, and it cannot be one
 * here: `next/font` subsets JetBrains Mono to `latin`, which has no glyphs at
 * U+2500, so every rule and corner falls back to a face with different metrics
 * and the table arrives crooked. Printing what the endpoint actually answers
 * with is the better trade anyway — it is one fewer thing on this page that a
 * reader would have to unlearn at the reference.
 */
export const RECALL = `# 2 — read it back, the same second
POST /api/v1/acme/ing_01H8Z…/query
{
  "sql": "SELECT company, arr
          FROM contacts
          WHERE stage = 'won'
          ORDER BY arr DESC"
}

200 OK · 34ms
{ "columns": ["company", "arr"],
  "rows": [ { "company": "Northwind",
              "arr": 184000 },
            { "company": "Contoso",
              "arr": 96500 } ],
  "truncated": false }`;

/** One endpoint, two ways of asking. Lifted from the reference's own sample. */
export const TWO_WAYS = `# structured
{ "sql": "SELECT company, arr FROM contacts
          WHERE stage = 'won'" }

# or in words
{ "text": "renewal risk in EMEA",
  "table": "notes", "column": "body" }`;

export const MCP_CONFIG = `# claude_desktop_config.json
{ "mcpServers": { "ingot": {
    "url": "http://localhost:3002/api/v1/
           acme/ing_01H8Z…/mcp",
    "headers": { "Authorization":
      "Bearer ing_sk_…" } } } }`;

/** The tools the MCP server exposes, at each of the two scopes it is mounted. */
export const MCP_TOOLS: readonly { readonly scope: string; readonly tools: string }[] = [
  { scope: 'account-wide', tools: 'create_memory · list_memories · delete_memory' },
  {
    scope: 'per memory',
    tools: 'describe · remember · query · recall · forget · configure_table · drop_table',
  },
];

/**
 * The whole of getting started, which is the repository's own quickstart.
 *
 * The `cp` is in it because it is genuinely not optional: `DATABASE_URL` is the
 * one setting with no default, and Ingot refuses to start without a database
 * rather than inventing an address for one.
 */
export const SELF_HOST = `# the copy is not optional — DATABASE_URL has no default
bun install
cp apps/ingot/.env.example apps/ingot/.env
bun run db:up     # Postgres and MinIO
bun run dev       # API on :3002, this site on :5174

# sign up against your own instance
curl -X POST http://localhost:3002/api/v1/accounts \\
  -d '{"slug":"acme","name":"Acme Inc"}'`;
