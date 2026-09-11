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
    body: 'One POST. Name it, say how long it lives — 30m for a session, 4w for a project — and keep the id it hands back.',
    route: 'POST /:account/create',
  },
  {
    n: '02',
    title: 'Store tool results',
    body: 'Map JSON paths onto typed columns and fan an array into rows. Set a key if you want upserts. Ask for a receipt and you get something small enough to hand back to the agent.',
    route: 'POST /:account/:ingot/add',
  },
  {
    n: '03',
    title: 'Query or recall',
    body: 'One SELECT, against a sandboxed DuckDB that unions the fresh rows with the Parquet. Or skip the SQL and ask in words.',
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
    body: 'JSON paths map onto real types, so a model can filter and count instead of re-reading the same text every turn.',
  },
  {
    kicker: 'Schema first',
    title: '/info',
    body: 'Tell the model exactly what is can query.',
  },
  {
    kicker: 'Sandboxed',
    title: 'Exactly one SELECT',
    body: 'Queries run in a locked-down DuckDB that unions the live overlay with Parquet. Nothing else gets through.',
  },
  {
    kicker: 'Retention',
    title: '30m to 4w, per memory',
    body: 'Scratch memory for a session, durable memory for a project. You set it once, when you cast the memory.',
  },
  {
    kicker: 'Search',
    title: 'Keyword, semantic, hybrid',
    body: 'BM25 with a configurable stemmer, cosine similarity over embedded columns, or both ranked in one SELECT. That is RAG retrieval, with nothing running beside it.',
  },
  {
    kicker: 'Keys',
    title: 'One bearer token',
    body: 'Mint and revoke labelled keys. You see a secret exactly once. MCP uses the same one, so there is no second auth path to wire up.',
  },
  {
    kicker: 'Delivery',
    title: 'Poll it, or be told',
    body: 'A receipt hands back the SELECT that finds your rows. Or point the memory at a webhook or a queue and each one gets pushed as it lands, out of an outbox that survives a restart.',
  },  
  {
    kicker: 'Joins',
    title: 'Across memory types',
    body: 'Every memory type is a table in the same database, so one SELECT can join a tool result to another on a value neither declared as a key — a file path in one, the team that owns it in another.',
  },
];

/**
 * The sentence under the title, and the one `layout.tsx` gives a search result
 * and a link preview as `description`.
 *
 * A constant because it is said in two places and they are read in either
 * order — a visitor who arrives from a search has read the preview first. Two
 * copies of a pitch drift on the edit that only remembers one of them, and
 * this is the pitch, so it is the one that gets edited.
 */
export const LEDE =
  'Models are good at writing SQL. Why rely on similarity searches, when you can let it ask for exactly what it needs?';

/** The row under the hero. What the thing already speaks, rather than logos. */
export const SPEAKS: readonly string[] = [
  'SQL Queries', 'Similarity Searches', 'Document Chunking'
];

/**
 * The left half of the terminal: a tool result going in.
 *
 * Pretty-printed the way a JSON formatter would leave it — one key to a line,
 * every closing brace on its own. The three column mappings are the exception
 * and stay one to a line, because they are a *table*: three rows of the same
 * four fields, where the alignment is what lets you read down the `type`
 * column instead of across nine lines to compare two of them.
 */
export const REMEMBER = `# 1 — remember a tool result
POST /api/v1/acme/ing_01H8Z…/add
{
  "table": "contacts",
  "rows": "$.contacts[*]",
  "columns": {
    "id":      { "from": "$.id",       "type": "VARCHAR" },
    "company": { "from": "$.org.name", "type": "VARCHAR" },
    "arr":     { "from": "$.deal.arr", "type": "DOUBLE"  }
  },
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
{
  "columns": ["company", "arr"],
  "rows": [
    { "company": "Northwind", "arr": 184000 },
    { "company": "Contoso",   "arr": 96500 }
  ],
  "truncated": false
}`;

/**
 * The two things a write can opt into, and what each hands back.
 *
 * Both are opt-in and they are opt-in at different grains, which is the point
 * worth making: `embed` is per memory type and set once when the type is
 * declared, `receipt` is per call because it costs a model call every time. A
 * page that showed them as one switch would be describing a product that
 * bills differently from this one.
 *
 * `summary` and `searchTerm` are null in the response and that is not a gap
 * being glossed over — it is the promise the receipt makes. Showing the query
 * answering underneath is the only honest way to draw it.
 */
export const RECEIPTS = `# opt in: per memory type, and per call
POST /api/v1/acme/ing_01H8Z…/add
{
  "table": "notes",
  "rows": "$.notes[*]",
  "columns": {
    "body": {
      "from": "$.body",
      "type": "VARCHAR",
      "embed": true
    }
  },
  "receipt": "full",
  "result": toolResult
}

201 Created · queuedForEmbedding 412
{
  "receipt": {
    "status": "pending",
    "model": "gpt-4.1-mini",
    "summary": null,
    "searchTerm": null,
    "receiptQuery": "SELECT … WHERE
                     source_batch = 'batch_1508c8…'"
  }
}

# seconds later, that query answers
{
  "summary": "412 call notes, 17 flagging
              renewal risk in EMEA",
  "search_term": "EMEA renewal risk"
}`;

/**
 * One endpoint, three ways of asking, and the switch that has to be on first.
 *
 * The `config` call opens the sample rather than being left out of it, and
 * that is the whole reason this constant is longer than the two-line one it
 * replaced. Keyword indexing is **off** until a table asks for it — see
 * `FtsSettings.default()` in the service, which explains why: the index is
 * built per session over the whole table, so defaulting it on would bill every
 * query of every memory for prose most of them do not hold. A sample that went
 * straight to `match_bm25` would be one somebody pastes, runs, and gets an
 * empty result from, with nothing on the page to say why.
 *
 * The third block is the argument the section makes. It is valid as written:
 * `match_bm25` may be computed in a SELECT list, and DuckDB will ORDER BY an
 * output alias, so the subquery the FTS docs wrap this in is not needed when
 * the ordering is the cosine column rather than the keyword one.
 */
export const RETRIEVAL = `# once — switch keyword indexing on
POST /api/v1/acme/ing_01H8Z…/config/notes
{ "fts": { "enabled": true } }

# ask by meaning. Rows come back scored.
POST /api/v1/acme/ing_01H8Z…/query
{
  "text": "renewal risk in EMEA",
  "table": "notes",
  "column": "body"
}

200 OK
{
  "columns": ["id", "body", "region", "score"],
  "rows": [{ "score": 0.83, … }]
}

# or all three at once — one round trip
{
  "text": "renewal risk in EMEA",
  "sql": "SELECT body, region,
            array_cosine_similarity(body_vec, $q) AS near,
            fts_main_notes.match_bm25(_row_id, 'renewal')
              AS words
          FROM notes
          WHERE region = 'EMEA' AND created > '2026-01-01'
          ORDER BY near DESC
          LIMIT 8"
}`;

/* ── where this goes in an agent loop ───────────────────────────────────── */

/**
 * One node of the wire diagram under "In the agent loop".
 *
 * Four of them, and the count is not arbitrary: the first exists to rule
 * something out. A reader arriving at a memory service assumes it wants to sit
 * between the model and the tool, and it does not — the dispatch is untouched
 * and the only edit is inside the tool's own body. Dropping node 01 would save
 * a cell and leave that assumption standing.
 */
export interface WireNode {
  /**
   * `01 · Harness`, or `02 · Your tool -> Ingot` for a hop between two of
   * them. The arrow is ASCII rather than U+2192 for the reason `.wire-node`
   * draws its arrowheads instead of typing them: the mono face is subsetted
   * to `latin` and does not carry one, so a real arrow here would arrive in
   * whatever the reader's system offers, half a size off the label it sits in.
   */
  readonly actor: string;
  readonly title: string;
  readonly body: string;
  /** The call, the id or the status the node is, printed under it. */
  readonly wire: string;
}

export const HARNESS: readonly WireNode[] = [
  {
    actor: '01 · Harness',
    title: 'Dispatches the tool',
    body: 'Unchanged. The model asks for a tool, your harness runs it, and nothing about that hop knows Ingot exists.',
    wire: 'toolCallId: call_01H8Z…',
  },
  {
    actor: '02 · Your tool -> Ingot',
    title: 'Sends the result to the memory',
    body: 'One POST, before you return. Send the tool-call id along as externalId and you can ask for this receipt back later by a name that means something to you.',
    wire: 'POST /:ingot/add',
  },
  {
    actor: '03 · Ingot -> your tool',
    title: 'Answers with a receipt',
    body: 'How many rows, which table, and a SELECT that returns exactly them. Return that as the tool output — it goes in the slot the blob would have filled.',
    wire: '201 · 412 rows',
  },
  {
    actor: '04 · Model -> Ingot',
    title: 'Reads back what it needs',
    body: 'Narrowed over typed columns, in this step or in a session next week. Twenty rows out of four hundred, picked by the model — not by whoever wrote the tool six months ago.',
    wire: 'POST /:ingot/query',
  },
];

/** The strip under the wire: what the loop closing actually buys. */
export const HARNESS_RETURN =
  'The rows outlive the turn. A receipt hands back SQL rather than an id, so it still finds them from a context window that never saw them go in.';

/**
 * The tool, as the AI SDK wants it written.
 *
 * Set against AI SDK 5, and the two names that moved in it are the two most
 * likely to be copied wrong: the schema is `inputSchema` (it was `parameters`),
 * and the multi-step loop is `stopWhen: stepCountIs(n)` (it was `maxSteps`).
 * `execute`'s second argument carrying `toolCallId` is the seam that makes any
 * of this work — it is the caller's own id for the result, which is exactly
 * what `externalId` is for.
 *
 * `post` is left undefined on purpose and said to be `fetch` with the bearer
 * key on it. Writing that helper out would be six lines of nothing, and this
 * sample has to fit a pane.
 */
export const AI_SDK_TOOL = `// tool.ts — AI SDK 5.
// post() is fetch with the bearer key on it.
import { tool } from 'ai';
import { z } from 'zod';

const INGOT = 'http://localhost:3002/api/v1/acme';
const memory = INGOT + '/ing_01H8Z…';

export const searchContacts = tool({
  description: 'Search the CRM by stage.',
  inputSchema: z.object({ stage: z.string() }),

  async execute({ stage }, { toolCallId }) {
    const result = await crm.contacts.search({ stage });

    const { receipt } = await post(memory + '/add', {
      table: 'contacts',
      rows: '$.contacts[*]',
      columns: {
        id:      { from: '$.id',       type: 'VARCHAR' },
        company: { from: '$.org.name', type: 'VARCHAR' },
        arr:     { from: '$.deal.arr', type: 'DOUBLE' } },
      key: ['id'],
      externalId: toolCallId,
      receipt: 'full',
      result,
    });

    // The 412 contacts stay in the memory. This
    // is what goes back in their place.
    return {
      rows: receipt.totalResults,
      table: receipt.table.name,
      query: receipt.query,
    };
  },
});`;

/**
 * The other half: what the model is handed, and what it does with it.
 *
 * The token figures are the argument this whole section makes, so they are the
 * one thing here that is an estimate and has to read as one — `about`, twice.
 * `payload.estimatedTokens` is what `/add` answers with and it says the same of
 * itself.
 */
export const AI_SDK_SEEN = `# the tool-result part, as the model reads it
{
  "rows": 412,
  "table": "contacts",
  "query": "SELECT * FROM contacts
            WHERE source_batch = 'batch_1508c8…'"
}

# about 180 tokens. The result it stands in
# for was 412 objects and about 48,000.

# the browser is handed the same small object,
# as the stream's tool-output-available part —
# it is one JSON either way, and this one fits

# next step — the model narrows it itself
POST /api/v1/acme/ing_01H8Z…/query
{
  "sql": "SELECT company, arr
          FROM contacts
          WHERE source_batch = 'batch_1508c8…'
            AND arr > 100000
          ORDER BY arr DESC
          LIMIT 20"
}

200 OK · 31ms
{
  "columns": ["company", "arr"],
  "rows": [
    { "company": "Northwind", "arr": 184000 },
    …
  ],
  "truncated": false
}`;

/** One of the three notes under the AI SDK sample. */
export interface SdkNote {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  /** The line of API the note is about, printed under it. */
  readonly hint: string;
}

/**
 * The three things the sample above does not show, and each is a thing
 * somebody would otherwise find out by shipping it.
 */
export const SDK_NOTES: readonly SdkNote[] = [
  {
    kicker: 'Stream',
    title: 'The write is not a model call',
    body: '/add returns the moment the rows land. The summary is written behind it and the receipt says pending, so your tool result is never sitting there waiting on a second model to finish a sentence.',
    hint: 'receipt.status: pending',
  },
  {
    kicker: 'Loop',
    title: 'Give it something to run SQL with',
    body: 'A receipt hands back a SELECT, which is only worth having if the model can run one. Wrap /query as a second tool, or point it at the MCP server and write neither.',
    hint: 'stopWhen: stepCountIs(8)',
  },
  {
    kicker: 'Your UI',
    title: 'The browser can still have the rows',
    body: 'Nothing headed for the interface has to go through the context window. Return the full result from execute and hand the model the receipt from toModelOutput. One gets streamed, the other gets read.',
    hint: 'toModelOutput()',
  },
];

/**
 * The MCP block, nested the way the file it goes in is nested.
 *
 * The URL sits on its own line under the key rather than being folded across
 * two, because a URL broken mid-path is one somebody reassembles wrongly — the
 * previous version put the `/` at the start of the second line and read as
 * though the path began there.
 */
export const MCP_CONFIG = `# claude_desktop_config.json
{
  "mcpServers": {
    "ingot": {
      "url":
        "http://localhost:3002/api/v1/acme/ing_01H8Z…/mcp",
      "headers": { "Authorization": "Bearer ing_sk_…" }
    }
  }
}`;

/** The tools the MCP server exposes, at each of the two scopes it is mounted. */
export const MCP_TOOLS: readonly { readonly scope: string; readonly tools: string }[] = [
  { scope: 'account-wide', tools: 'create_memory · list_memories · delete_memory' },
  {
    scope: 'per memory',
    tools:
      'describe · remember · query · recall · forget · configure_table · configure_delivery · drop_table',
  },
];

/**
 * One row of "What it's not": a job a full RAG stack does, and what Ingot does
 * about it. Backticks are code, through `Prose`.
 *
 * The README's "Against RAG" is the source, and the claims here should not get
 * ahead of it — in particular the four it leaves out are the ones the README
 * lists, not a softer set.
 */
export interface RagContrast {
  readonly job: string;
  readonly rag: string;
  readonly ingot: string;
}

/** The half of a RAG stack that stores and finds. */
export const RAG_REPLACED: readonly RagContrast[] = [
  {
    job: 'Chunk documents',
    rag: 'A loader and a splitter in front of the store.',
    ingot: '`/file` chunks per format, and can pull typed rows out of the same file.',
  },
  {
    job: 'Embed',
    rag: 'A pipeline writing vectors into another system.',
    ingot: 'Opt in per memory type. A sweeper works the queue.',
  },
  {
    job: 'Store vectors',
    rag: 'A vector database beside your data.',
    ingot: 'The same tables as the rows. No second database.',
  },
  {
    job: 'Retrieve',
    rag: '`top_k(embedding)`.',
    ingot: 'SQL, with cosine and BM25 as ranking functions inside it.',
  },
  {
    job: 'Count, aggregate, sort by time',
    rag: 'No nearest-neighbour formulation.',
    ingot: 'A `GROUP BY` and an `ORDER BY`.',
  },
  {
    job: 'Join sources',
    rag: 'One index per query.',
    ingot: 'One SELECT across memory types — chunks, files and typed rows together.',
  },
  {
    job: 'What goes in',
    rag: 'Documents.',
    ingot: 'An agent’s own tool results, typed. Documents are a second way into the same tables.',
  },
];

/** The half that writes the answer, and the rest of what a mature stack has. */
export const RAG_LEFT_OUT: readonly RagContrast[] = [
  {
    job: 'Write the answer',
    rag: 'Top-k chunks into the prompt, then a model call.',
    ingot: 'Not done here. Rows come back; the agent writes the answer.',
  },
  {
    job: 'Rerank and rewrite',
    rag: 'A reranker, often a query rewriter.',
    ingot: 'Neither. Hybrid means the SQL you wrote ranks on BM25 and cosine together.',
  },
  {
    job: 'ANN index',
    rag: 'HNSW or similar.',
    ingot: 'None. Brute-force cosine, a good trade until the low millions of rows per table.',
  },
  {
    job: 'Schema',
    rag: 'None asked for.',
    ingot: 'Required up front for `/add`. A real cost, and one the benchmark does not put a number on.',
  },
];

/*
 * Getting started used to be a constant here, printed in the closing band.
 * It is `src/landing/targets.ts` now — the local target's `run` and `check` —
 * because it stopped being the only way to bring one up the moment there was a
 * chart, and a quickstart written in two places is one that disagrees with
 * itself on the second edit.
 */
