/**
 * What `/why` says, as data — the same argument
 * `src/landing/sections.ts` makes for its own page.
 *
 * This one is the only page on the site that is a *position* rather than a
 * description, which raises rather than lowers the bar on it: a claim about
 * why something is built this way is checkable against the thing it is built
 * into, and every claim below is. Where one of them is a fact about the
 * repository, the file that decides it is named in the comment above it, so
 * that a reader who does not believe the page can go and disagree with the
 * code instead.
 *
 * The samples obey the same rule the landing page's do — real requests against
 * `@ingot/shared/ingot-v1`, `localhost` addresses because that is the only
 * kind Ingot has, and no line wider than the pane it renders in.
 */

/** What the tab, the index entry and the metadata description call this. */
export const WHY_TITLE = 'Similarity is not a join';

export const WHY_DESCRIPTION =
  'Why Ingot is a query engine rather than a vector store: models write SQL, tool results are tables, and the questions worth asking are joins across them. What a memory is scoped to, what it costs to keep, and who owns what is in it.';

/**
 * The paragraph under the title, and the page's `description`.
 *
 * A constant for the reason `LEDE` is one over on the landing page: it is read
 * in either order — a visitor who arrives from a search has read the preview
 * first — and two copies drift on the edit that only remembers one.
 */
export const WHY_LEDE =
  'A vector store answers one question: what is this like? The questions an agent actually has are joins — which of these also, how many, in what order, compared to when. Models write SQL well enough to ask those, so a memory’s job is to hold tool results as tables and then get out of the way.';

/* ── 01 · what happens to a tool result today ────────────────────────────── */

/** One of the three cells under "Three ways to lose a tool result". */
export interface Loss {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  /** What it costs, printed under it. */
  readonly cost: string;
}

/**
 * The three, and they are the three because they are exhaustive rather than
 * illustrative: a tool result is kept in the window, replaced by prose about
 * itself, or turned into vectors. There is no fourth thing anybody does with
 * one, which is what makes the section an argument rather than a list of
 * complaints.
 */
export const LOSSES: readonly Loss[] = [
  {
    kicker: 'Kept',
    title: 'It stays in the window',
    body: 'Four hundred objects, read once and paid for on every turn after — until the window is trimmed, and then it is as though the call never happened.',
    cost: 'about 48,000 tokens',
  },
  {
    kicker: 'Summarised',
    title: 'A model writes a paragraph about it',
    body: 'The prose survives and the numbers do not. Nothing downstream can filter it, sort it or count it, and the rows it was made from have already been discarded.',
    cost: 'lossy, and final',
  },
  {
    kicker: 'Embedded',
    title: 'It is chunked into a vector store',
    body: 'Now exactly one question may be asked of it, and it is asked by example: what is this like? Not how many, not which of these also, not in what order.',
    cost: 'top-k, and no more',
  },
];

/** The strip under the three, which is the claim they add up to. */
export const LOSS_CLAIM =
  'All three are lossy in the same direction. What is thrown away is the structure — the fact that this was four hundred rows of six typed fields, and that a question could have been asked of them.';

/* ── 02 · why SQL ────────────────────────────────────────────────────────── */

/**
 * Three tools that have never heard of each other, writing into one memory.
 *
 * The point of the sample is the `"table"` line in each block and nothing
 * else: three calls, three tables, one ingot. Each is a real `/add` — a JSON
 * path per column, a `type` per column, and `key` only on the one that has an
 * identity worth upserting on.
 */
export const THREE_TOOLS = `# three tools. one memory. three tables.
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
  "result": crmResult
}

POST /api/v1/acme/ing_01H8Z…/add
{
  "table": "invoices",
  "rows": "$.data[*]",
  "columns": {
    "account": { "from": "$.customer",  "type": "VARCHAR" },
    "due":     { "from": "$.due_date",  "type": "DATE"    },
    "status":  { "from": "$.status",    "type": "VARCHAR" }
  },
  "result": stripeResult
}

POST /api/v1/acme/ing_01H8Z…/add
{
  "table": "tickets",
  "rows": "$.tickets[*]",
  "columns": {
    "account": { "from": "$.org",       "type": "VARCHAR" },
    "opened":  { "from": "$.created",   "type": "DATE"    },
    "subject": { "from": "$.subject",   "type": "VARCHAR" }
  },
  "result": deskResult
}`;

/**
 * The question none of the three tools could have answered.
 *
 * Three tables in one FROM clause, which works because a query is offered
 * every table its memory holds and the engine narrows to the ones the
 * statement names — `sessions.all(tables)` in
 * `apps/ingot/src/contexts/query/application/queries/query-ingot.query.ts`.
 *
 * `INTERVAL '30 days'` rather than `INTERVAL 30 DAY`: both are DuckDB, and the
 * quoted form is the one that is also every other dialect, so a reader porting
 * the shape somewhere else is not copying a DuckDB-ism they did not ask for.
 */
export const THE_JOIN = `# a question no tool call could have answered
POST /api/v1/acme/ing_01H8Z…/query
{
  "sql": "SELECT c.company, c.arr, count(*) AS raised
          FROM invoices i
          JOIN contacts c ON c.company = i.account
          JOIN tickets  t ON t.account = i.account
          WHERE i.status = 'past_due'
            AND t.opened BETWEEN i.due
                AND i.due + INTERVAL '30 days'
          GROUP BY 1, 2
          ORDER BY c.arr DESC"
}

200 OK · 41ms
{
  "columns": ["company", "arr", "raised"],
  "rows": [
    { "company": "Northwind", "arr": 184000, "raised": 7 },
    { "company": "Contoso",   "arr": 96500,  "raised": 3 }
  ],
  "truncated": false
}`;

/** One of the three notes under the join. */
export interface SqlNote {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  /** The thing in the service that makes it true, printed under it. */
  readonly source: string;
}

/**
 * What the sample above is standing on. Each is a fact about a named file
 * rather than a property of SQL in general, because the interesting half of
 * this argument is that the guard rails exist — a model writing SQL against a
 * memory is only a good idea if the worst statement it can write is a slow
 * SELECT.
 */
export const SQL_NOTES: readonly SqlNote[] = [
  {
    kicker: 'Scope',
    title: 'Every table of the memory is in scope',
    body: 'A statement is offered each table its ingot holds, and the engine narrows to the ones it actually names. Three tools that never heard of each other are three tables in one FROM clause.',
    source: 'sessions.all(tables)',
  },
  {
    kicker: 'Sandbox',
    title: 'The worst case is a slow SELECT',
    body: 'One statement, and it must be a read. No ATTACH, no COPY, no second statement, no writes — with a row cap and a timeout on the one thing that does run.',
    source: 'assertStartsAsSelect()',
  },
  {
    kicker: 'Schema',
    title: 'It is told what is there first',
    body: 'Tables, columns and types come out of Postgres with no bucket read behind them, so asking is cheap enough to do every turn. Over MCP they arrive as the server’s instructions, before the first tool call.',
    source: 'GET /:ingot/info',
  },
];

/* ── 03 · where the embeddings went ──────────────────────────────────────── */

/**
 * Meaning as one predicate among several.
 *
 * Deliberately not the landing page's retrieval sample: that one ranks a
 * single table and makes the "no vector database" argument. This one *joins*
 * while it ranks, which is the argument this page is making — the cosine is an
 * expression in a SELECT list, so it composes with everything else a SELECT
 * can do. The version with a vector store beside it cannot write this
 * statement at all.
 *
 * `$q` is bound only when `text` and `sql` arrive together, so the `text` line
 * is load-bearing rather than decorative.
 */
export const VECTOR_COLUMN = `# rank by meaning, inside a join
POST /api/v1/acme/ing_01H8Z…/query
{
  "text": "unhappy about the renewal price",
  "sql": "SELECT c.company, c.arr, n.body,
                 array_cosine_similarity(n.body_vec, $q)
                   AS near
          FROM notes n
          JOIN contacts c ON c.id = n.contact_id
          WHERE c.arr > 100000
            AND n.written > '2026-01-01'
          ORDER BY near DESC
          LIMIT 10"
}`;

/* ── 04 · what a memory is scoped to ─────────────────────────────────────── */

/** One of the four cells under "One memory per whatever you say". */
export interface Grain {
  /** The `retainFor` it implies, or the fact that there is none. */
  readonly retention: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Four scopes, and the point is that Ingot has an opinion about none of them.
 *
 * The retentions are real: `retainFor` takes a whole number and a unit from
 * one minute to ten years, or is omitted to keep a memory until something
 * deletes it — `apps/ingot/src/contexts/ingots/domain/retention.vo.ts`. The
 * four below are the shapes people actually have, not the four the grammar
 * allows.
 */
export const GRAINS: readonly Grain[] = [
  {
    retention: 'retainFor: "30m"',
    title: 'Per chat',
    body: 'A scratch memory for one conversation. The tool results of this session, joinable to each other and to nothing else, gone half an hour after the last one lands without anybody running a cleanup.',
  },
  {
    retention: 'retainFor: "12h"',
    title: 'Per run',
    body: 'One agent run, one batch, one incident. Long enough that a retry an hour later reads what the first attempt wrote, and short enough that a failed run is not something to tidy up.',
  },
  {
    retention: 'retainFor: "4w"',
    title: 'Per project',
    body: 'What a piece of work accumulates: every tool that touches the project writing into tables of the same ingot, and a month in which to ask questions across all of them.',
  },
  {
    retention: 'no retainFor',
    title: 'Per user, per tenant, per agent',
    body: 'Kept until something deletes it, which is the right answer for a memory whose lifetime is somebody’s account rather than a clock. Expiry is opt-in because it is not reversible.',
  },
];

/**
 * The constraint that makes the choice above a real one.
 *
 * Said plainly rather than left to be discovered, because it is the single
 * thing on this page that could disappoint somebody after they had built on
 * it: a query resolves the tables of one ingot, and there is no statement that
 * spans two.
 */
export const GRAIN_LIMIT =
  'A statement sees the tables of one memory, and there is no query across two. That is the one decision worth making deliberately — **the grain you pick is the grain you can join across** — and casting a memory is one POST, so it is a decision you are allowed to change your mind about.';

/** How the memories themselves are managed, at the account scope. */
export const GRAIN_CHIPS: readonly string[] = [
  'POST /:account/create',
  'GET /:account/ingots',
  'create_memory',
  'list_memories',
  'delete_memory',
];

/* ── 05 · what it costs to keep ──────────────────────────────────────────── */

/** One of the three tiers, in the order a row passes through them. */
export interface Tier {
  readonly n: string;
  readonly title: string;
  readonly body: string;
  /** What the tier is for, in three words, printed under it. */
  readonly note: string;
}

/**
 * The storage model, which is an LSM tree and nothing more exotic. Every
 * number here is read off the service: the roll-up is `minutes(5)` in
 * `apps/ingot/src/sweepers/roll-up.sweeper.ts`, and one generation is one
 * complete rewrite of the table rather than a delta —
 * `compact-table.command.ts` writes a single part per generation from the base
 * files unioned with the overlay.
 */
export const TIERS: readonly Tier[] = [
  {
    n: '01',
    title: 'The overlay',
    body: 'Rows land in Postgres and are queryable in the same second, beside the manifest that says where the folded ones went. This is the only tier a write touches.',
    note: 'queryable on arrival',
  },
  {
    n: '02',
    title: 'The base tier',
    body: 'Every five minutes a sweeper folds the overlay into a new Parquet generation — one file per table, columnar and compressed, in a bucket you named.',
    note: 'one file per table',
  },
  {
    n: '03',
    title: 'The engine',
    body: 'DuckDB is a library inside the process, never a server. A query builds an in-memory session from the manifest, runs one statement against it and throws it away.',
    note: 'nothing stays warm',
  },
];

/** One line of the ledger under the tiers. */
export interface Cost {
  readonly item: string;
  /** Backticks render as code. */
  readonly body: string;
}

/**
 * What a memory actually costs, including the three lines that are zero.
 *
 * The zeroes are the argument. A vector database is priced on being resident —
 * an index sized to the corpus, kept warm whether or not anybody is asking —
 * and none of the three tiers above is resident, so the bill for a memory
 * nobody is querying is the bytes it occupies.
 */
export const COSTS: readonly Cost[] = [
  {
    item: 'Bucket bytes',
    body: 'Parquet, columnar and compressed. This is the memory at rest, and the only thing an idle one costs.',
  },
  {
    item: 'A Postgres',
    body: 'The catalogue, the rows written since the last roll-up, and the queues. Almost certainly one you were already running for something else.',
  },
  {
    item: 'CPU, while a query runs',
    body: 'A DuckDB session is built from the manifest, used once and dropped. Between two queries a memory is consuming nothing that could be scaled up.',
  },
  {
    item: 'Nothing per vector',
    body: 'Embeddings are Parquet in the same bucket, keyed by `_row_id` beside the rows they belong to. There is no per-dimension price and no index node.',
  },
  {
    item: 'Nothing per memory',
    body: 'Casting an ingot writes a row. Ten thousand scratch memories that expire tonight are ten thousand rows tonight and nothing tomorrow.',
  },
  {
    item: 'Nothing while idle',
    body: 'No index to keep warm, no cluster sized to the corpus, no minimum. A memory nobody is querying is some Parquet in a bucket.',
  },
];

/* ── 06 · whose memory it is ─────────────────────────────────────────────── */

/**
 * The base tier, read without Ingot in the picture.
 *
 * Honest in the two places it would be easy not to be. The highest `gen-`
 * directory is the current one *and* is the whole table, because a compaction
 * rewrites rather than appends — so this is not a partial view somebody would
 * have to reassemble. And the last few minutes of writes are not in it, which
 * the sample says out loud rather than leaving to be found.
 */
export const OWN_IT = `# ingot is not running. the memory still is.
# the highest gen- directory is the whole table.

$ duckdb
D SELECT company, sum(arr) AS book
  FROM read_parquet(
    'acct_…/ing_…/tables/contacts/gen-000003/*.parquet'
  )
  GROUP BY 1
  ORDER BY book DESC;

# there is no export step, because there was
# never a second format to export from. what is
# missing is the last five minutes, which are
# still in your Postgres.`;

/** The chips under the ownership split. */
export const OWNERSHIP_CHIPS: readonly string[] = [
  'your bucket',
  'your Postgres',
  'Parquet',
  'no export step',
  'no vendor',
];
