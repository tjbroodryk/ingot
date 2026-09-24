/** What `/why` says, as data. Samples are real requests against `@ingot/shared/ingot-v1`. */

/** What the tab, the index entry and the metadata description call this. */
export const WHY_TITLE = 'Similarity is not a join';

export const WHY_DESCRIPTION =
  'Why Ingot is a query engine rather than a vector store: models write SQL, tool results are tables, and the questions worth asking are joins across them. What a memory is scoped to, what it costs to keep, and who owns what is in it.';

/** The paragraph under the title, and the page's `description`. */
export const WHY_LEDE =
  'A vector store answers exactly one question: what is this like? That is rarely the question an agent actually has. The real ones are joins — which of these also, how many, in what order, compared to when. Models write SQL well enough to ask all of those, so we think a memory’s job is to hold tool results as tables and then get out of the way.';

/* ── 01 · what happens to a tool result today ────────────────────────────── */

/** One of the three cells under "Three ways to lose a tool result". */
export interface Loss {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  /** What it costs, printed under it. */
  readonly cost: string;
}

/** The three things done with a tool result today: kept, summarised, embedded. */
export const LOSSES: readonly Loss[] = [
  {
    kicker: 'Kept',
    title: 'It stays in the window',
    body: 'Four hundred objects, read once and paid for on every turn after that. Until the window gets trimmed, and then it is as if the call never happened at all.',
    cost: 'about 48,000 tokens',
  },
  {
    kicker: 'Summarised',
    title: 'A model writes a paragraph about it',
    body: 'The prose survives, the numbers do not. Nothing downstream can filter it, sort it or count it, and the rows it was written from are already gone.',
    cost: 'lossy, and final',
  },
  {
    kicker: 'Embedded',
    title: 'It is chunked into a vector store',
    body: 'Now there is one question you can ask of it, and you have to ask it by example: what is this like? Not how many. Not which of these also. Not in what order.',
    cost: 'top-k, and no more',
  },
];

/** The strip under the three. */
export const LOSS_CLAIM =
  'All three lose the same thing, which is the structure. The fact that this was four hundred rows of six typed fields, and that you could have asked a real question of them.';

/* ── 02 · why SQL ────────────────────────────────────────────────────────── */

/** Three tools that have never heard of each other, writing into one memory. */
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

/** The question none of the three tools could have answered: three tables in one FROM clause. */
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

/** What the sample above is standing on: each a fact about a named file, not SQL in general. */
export const SQL_NOTES: readonly SqlNote[] = [
  {
    kicker: 'Scope',
    title: 'Every table of the memory is in scope',
    body: 'A statement gets offered every table its ingot holds, and the engine narrows to the ones it actually names. Three tools that have never heard of each other are three tables in one FROM clause.',
    source: 'sessions.all(tables)',
  },
  {
    kicker: 'Sandbox',
    title: 'The worst case is a slow SELECT',
    body: 'One statement, and it has to be a read. No ATTACH, no COPY, no second statement, no writes. The one thing that does run has a row cap and a timeout on it.',
    source: 'assertStartsAsSelect()',
  },
  {
    kicker: 'Schema',
    title: 'It is told what is there first',
    body: 'Tables, columns and types come out of Postgres with no bucket read behind them, so asking is cheap enough to do every turn. Over MCP they arrive as the server’s instructions, before the model has spent a single tool call.',
    source: 'GET /:ingot/info',
  },
];

/* ── 03 · where the embeddings went ──────────────────────────────────────── */

/** Meaning as one predicate among several: cosine as a SELECT expression, joined while it ranks. `$q` is bound only when `text` and `sql` arrive together. */
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

/** Four scopes Ingot has no opinion about. */
export const GRAINS: readonly Grain[] = [
  {
    retention: 'retainFor: "30m"',
    title: 'Per chat',
    body: 'A scratch memory for one conversation. This session’s tool results, joinable to each other and to nothing else, gone half an hour after the last one lands. Nobody has to run a cleanup.',
  },
  {
    retention: 'retainFor: "12h"',
    title: 'Per run',
    body: 'One agent run, one batch, one incident. Long enough that a retry an hour later reads what the first attempt wrote, and short enough that a failed run is not something you have to go and tidy up.',
  },
  {
    retention: 'retainFor: "4w"',
    title: 'Per project',
    body: 'What a piece of work accumulates: every tool that touches the project writing into tables of the same ingot, and a month in which to ask questions across all of them.',
  },
  {
    retention: 'no retainFor',
    title: 'Per user, per tenant, per agent',
    body: 'Kept until something deletes it. That is the right answer when the lifetime is somebody’s account rather than a clock — and expiry is opt-in precisely because you cannot undo it.',
  },
];

/** The constraint that makes the scope choice a real one: a query spans one memory. */
export const GRAIN_LIMIT =
  'A statement sees the tables of one memory, and there is no query across two. So this is the one decision worth making deliberately: **the grain you pick is the grain you can join across**. Casting a memory is one POST, though, so it is also a decision you are allowed to change your mind about.';

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

/** The storage model, an LSM tree: overlay in Postgres, base in Parquet, DuckDB per query. */
export const TIERS: readonly Tier[] = [
  {
    n: '01',
    title: 'The overlay',
    body: 'Rows land in Postgres and are queryable the same second, next to the manifest that says where the folded ones went. This is the only tier a write ever touches.',
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
    body: 'DuckDB is a library inside the process, never a server. A query builds an in-memory session from the manifest, runs one statement against it, and throws the whole thing away.',
    note: 'nothing stays warm',
  },
];

/** One line of the ledger under the tiers. */
export interface Cost {
  readonly item: string;
  /** Backticks render as code. */
  readonly body: string;
}

/** What a memory actually costs, including the three lines that are zero. */
export const COSTS: readonly Cost[] = [
  {
    item: 'Bucket bytes',
    body: 'Parquet, columnar and compressed. This is the memory at rest, and the only thing an idle one costs.',
  },
  {
    item: 'A Postgres',
    body: 'The catalogue, the rows written since the last roll-up, and the queues. Almost certainly a Postgres you were already running for something else.',
  },
  {
    item: 'CPU, while a query runs',
    body: 'A DuckDB session is built from the manifest, used once, and dropped. Between two queries a memory is consuming nothing you could scale up even if you wanted to.',
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

/** The base tier, read without Ingot in the picture. */
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
