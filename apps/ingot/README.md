# @ingot/server

An agent memory server. Post tool results at it, get them back as SQL.

```bash
bun run extensions  # once per machine: fetches DuckDB's fts into ~/.duckdb
bun run dev         # http://localhost:3002/api/v1
bun run test        # needs `bun run db:up` from the repo root
```

Agents produce tool results all day and throw them away. What survives is
whatever the model happened to keep in context — a summary of a summary,
unqueryable, gone at the end of the turn. There is no way to ask "which files
did I read in this repo last week" or "what did the CI check say the last four
times it failed", because nothing structured was ever written down.

An **ingot** is one memory: a block of refined material that tool calls are
poured into and that cools into something queryable.

## The shape

An LSM tree, and everything else follows from it.

```
        /add ──────────────►  overlay        (Postgres, queryable instantly)
                                 │
                          roll-up sweeper    (every 5 minutes)
                                 ▼
       /query ◄── DuckDB ──►  base tier      (Parquet, in a bucket)
                    ▲            │
                    └────────────┘
                  a query unions both
```

- **Parquet in bucket storage is the base.** Cold, columnar, cheap, and
  portable — a memory is a directory of files somebody can download and open in
  any DuckDB, with or without this service.
- **Writes land in an overlay in Postgres.** A row is queryable the instant it
  is accepted. Nothing waits on a file being rewritten.
- **Reads union the two.** One logical table per tool, whether a row arrived
  four seconds or four weeks ago.
- **A sweeper folds the overlay into new Parquet** on a schedule, and the same
  question gets the same answer either side of that. That property is not a
  nice-to-have; it is the only thing that makes two tiers worth having, and
  `test/application/rollup-equivalence.test.ts` is what holds it up.

**DuckDB is the engine, never the store.** A fresh in-memory instance per
query, built from the manifest, hardened, used once, thrown away.

## The API

Everything is under `/api/v1`. Authentication is an API key —
`Authorization: Bearer ing_sk_…` — because the caller is a program.

**There is no sign-up route.** Which accounts exist is decided by `INGOT_AUTH`
at boot, and there is no default: a service that guessed how to authenticate
would be guessing who may read the memories in it. Sealed mode — the
self-hosting answer, and currently the only one — opens the single account
named in `INGOT_ACCOUNT` when it starts, and honours the root key in
`INGOT_API_KEY`. Rotating that key is a change to the secret and a restart.

| Route                                   |                                                                      |
| --------------------------------------- | -------------------------------------------------------------------- |
| `GET /accounts/:account`                | The account and the keys on it. Metadata only.                       |
| `POST /accounts/:account/keys`          | Mint another. `DELETE …/keys/:keyId` revokes one.                    |
| `POST /:account/create`                 | Cast an ingot. `retainFor` sets a retention.                         |
| `GET /:account/ingots`                  | List them.                                                           |
| `POST /:account/:ingot/add`             | Store a tool result.                                                 |
| `POST /:account/:ingot/file`            | Store a document. Multipart. Chunks and rows follow.                 |
| `POST /:account/:ingot/query`           | DuckDB SQL, plain language, or both.                                 |
| `GET /:account/:ingot/info`             | The information schema, settings included.                           |
| `POST /:account/:ingot/config`          | Set where receipts are delivered. A patch; returns the whole config. |
| `POST /:account/:ingot/config/:table`   | Set how a table is searched. A patch; returns the whole config.      |
| `POST /:account/:ingot/delete`          | Forget rows matching a predicate.                                    |
| `DELETE /:account/:ingot/tables/:table` | Drop a table.                                                        |
| `DELETE /:account/:ingot`               | Destroy the memory.                                                  |
| `ALL /:account/:ingot/mcp`              | MCP, scoped to this memory.                                          |

Minted keys are stored as a SHA-256 digest and nothing else, and are returned
once, in the response that created them; there is no way to read one back. The
root key is not stored at all — it is compared against a digest held in the
process, so there is no row to revoke, to leave behind on a rotation, or to go
stale. It is the credential that cannot be locked out, which is what makes
revoking any of the others safe.

### Walking through it

```bash
# The account and the key are the ones the server was started with.
export KEY=$(grep '^INGOT_API_KEY=' .env | cut -d= -f2)

curl -sX POST localhost:3002/api/v1/dev/create -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"name":"pull request memory"}'
# → { "id": "ing_7f2c…" }
```

## Versioning

Every response carries `Ingot-Version`, saying which contract you were served.
Send the same header on a request to pin it; omit it and you get the newest
shape.

```bash
curl -s $A/$ING/info -H "authorization: Bearer $KEY" -H 'Ingot-Version: 2026-08-26' -i
```

**Only the newest shape is implemented anywhere in this service.** Older
versions are that shape with small, two-way transforms in front of it —
`packages/versioning` is the engine and `src/versioning/changeset.ts` is the
list. Adding a version means changing the contract freely and then writing down
what moved; there is no branch inside a handler, ever.

Two things a change may not do, both asserted by `versioning.test.ts`:

- **Touch caller-owned data.** `QueryResult.rows` is your table contents and
  `AddBody.result` is your tool result. A transform reaching into either would
  rewrite your data to satisfy an envelope rename.
- **Change behaviour.** A version is a rendering of one implementation. A
  release that made the service _do_ something different would be a second
  product wearing the same name.

`GET /api/versions` lists what exists. Three releases: the baseline;
`2026-08-27`, where every `TableInfo` gained a `config` — rendered away again
for a caller pinned to the baseline, in `/info` and in an `/add` receipt alike;
and `2026-09-06`, where the memory itself gained one, holding where its receipts
are delivered.

## The mapping

`/add` takes an arbitrary tool result and a mapping saying how to project it
into typed columns. This is the heart of the write path.

```jsonc
POST /api/v1/acme/ing_7f2c/add
{
  "table": "pr_files",
  "rows": "$.files[*]",            // fan one blob out into a row per element
  "key":  ["pr", "path"],          // what identifies a row, for receipts
  "columns": {
    "pr":    { "from": "$$.pull_request.number", "type": "INTEGER"  },
    "path":  { "from": "$.filename",             "type": "VARCHAR"  },
    "adds":  { "from": "$.additions",            "type": "INTEGER"  },
    "patch": { "from": "$.patch", "type": "VARCHAR", "embed": true  },
    "seen":  { "value": "2026-08-26T09:12:00Z",  "type": "TIMESTAMP"}
  },
  "result": { "pull_request": { "number": 42 }, "files": [ … ] }
}
```

`$.` walks the current row and `$$.` walks the whole blob — which is what makes
fanning out useful: a row per file that still knows its pull request number.
Paths are read in TypeScript, not handed to DuckDB, which keeps caller text off
the SQL path entirely.

**Types are declared, never inferred.** Inference gives you a column that is
`BIGINT` on Monday and `VARCHAR` on Tuesday, and a saved query that quietly
starts returning nothing. Values are coerced at `/add` and a failure is a 422
naming the column and the value — the person who wrote the mapping is the
person who can fix it, and they are still holding the response.

Every row also gets `_row_id`, `_ingested_at` and `_batch`; `"raw": true` adds
`_raw` holding the whole blob. Callers may not declare a `_`-prefixed column.

**Schema evolution**: the first write to a table creates it. Later writes may
introduce columns — added _optional_, since the Parquet already written lacks
them — but may not change an existing column's type, and may not change the
key. Both are a 409 naming what moved, and the way out is
`DELETE …/tables/:table`.

## Documents

`/file` is `/add` with three things in front of it: **bytes → structure →
JSON**. Everything after that already existed, and that is the whole design —
one write path, and no read paths at all.

```bash
curl -sX POST $A/$ING/file -H "authorization: Bearer $KEY" \
  -F 'file=@handbook.md;type=text/markdown'
```

```jsonc
{
  "fileId": "file_e0c60d05…",
  "status": "pending",
  "query": "SELECT … FROM \"ingot_files\" WHERE \"file_id\" = 'file_e0c60d05…'",
  "chunksQuery": "SELECT … FROM \"ingot_chunks\" WHERE \"file_id\" = 'file_e0c60d05…'",
}
```

**It cannot be synchronous.** Parsing a two-hundred-page PDF is seconds to
minutes, `Dispatcher.send` wraps every command in a transaction, and the pool
holds ten connections — so a handler that parsed would hold a tenth of the pool
for the length of a document and starve the queries this service exists to
answer, while presenting as a database problem. So it is the same three-step
split the receipt, embedding and delivery workers use, for the fourth time:
claim, parse with no connection held, write. What comes back is a promissory
note, which is what `receipt: "summary"` already hands back and for the same
reason.

The bytes go to the object store beside the Parquet. A fifty-megabyte deck in a
`jsonb` column is exactly the failure `INGOT_STORAGE` refuses to boot without a
decision about — and keeping the original is what will make re-chunking
possible, since every chunking decision is baked into rows at write time and
rows are append-only.

### Two more ordinary tables

`ingot_files` is a row per document; `ingot_chunks` is a row per chunk, keyed on
`(file_id, ordinal)`. Both are **ordinary tables in your memory**, which is the
same argument `ingot_receipts` makes and the reason this feature is small: they
get the overlay, the embedding sweeper, the roll-up into Parquet, tombstones,
`/query` over both tiers and deletion with the memory, none of it written a
second time.

A row in `ingot_files` only ever holds a terminal status — `ready` or `failed`.
Rows are append-only, so a status that moved through `pending` and `parsing`
would mean tombstoning and re-appending a row twice per upload for two states
nobody can act on. While a document is in flight there is no row; `/file` says
`pending` in its own response because that is the only honest thing it can say.
What is in flight is `ingot_files_pending` and `ingot_files_abandoned` instead,
kept apart because they mean opposite things.

An abandoned document still gets a row, which is the one place this improves on
a receipt: `status` is `failed`, `error` says what happened, and nobody has to
guess whether their upload is slow or dead.

### Chunking, which is per format

The rule, and it is the whole of it: **split on the strongest boundary the
format actually gives you, and fall back exactly one level at a time.**

| format         | boundary                       |                                                                     |
| -------------- | ------------------------------ | ------------------------------------------------------------------- |
| `.pptx`        | one slide, always              | A slide is an authored unit. Never split one, never merge two.      |
| `.docx` `.md` `.html` | the heading hierarchy   | Explicit and reliable, and the path is carried into the text.       |
| `.pdf`         | the page, then the paragraph   | Pages are real; headings are guessed from font runs and often wrong.|
| `.csv` `.xlsx` | not chunked as prose           | It already has rows. See below.                                     |
| `.txt`         | paragraph → sentence → window  | Nothing to exploit. The fallback, never the default.                |

Carrying the heading path into the embedded text is the single highest-value
line in `chunker.ts`. A chunk reading "…within thirty days of written notice"
ranks against "what is the termination notice period" only if "4.2 Notice"
travels with it — the body is the answer and the heading is the question's
vocabulary, and they are in different blocks.

**Which boundary is not a caller's choice**, because there is no case where
cutting a deck every 512 tokens beats cutting it every slide. `chunkTokens` and
`overlapTokens` are, per upload or per deployment, because those are a function
of your embedder and your context budget. Overlap is applied only where the
boundary was ours — a slide does not bleed into the next slide.

### Pulling typed rows out

```jsonc
// a spreadsheet: real field names, so paths resolve and NO MODEL IS CALLED
{ "extract": {
    "table": "invoices",
    "rows": "$[*]",
    "key": ["invoice_no"],
    "columns": {
      "invoice_no": { "from": "$[\"Invoice #\"]", "type": "VARCHAR" },
      "amount":     { "from": "$.Amount",         "type": "INTEGER" }
}}}
```

This goes through **`RowMapping` — the same mapping `/add` uses** — so it is the
same paths, the same declared types, the same coercion and the same schema
evolution. Reimplementing any of that would be a second projection with its own
opinions, and the two would drift. `$["Invoice #"]` is the quoted-key form the
path grammar gained here, because `Invoice #` and `Total (USD)` are what real
header rows say and a caller has no choice about them.

Prose has no field names to path into, so its columns carry `describe` and a
model fills them against a schema it is held to — the same trick
`RECEIPT_SCHEMA` plays. **That rung is not built yet**: a prose extraction
parses and chunks and its extracted table stays empty, with a line in the log
saying so. Mixing the two forms is refused rather than resolved, because a
mapping half paths and half descriptions is one whose author has not decided
what they uploaded.

Everything refusable is refused **at upload**, while the caller is still holding
the response — the media type, the size, every path in the mapping, the
chunking knobs. That is the `/add` rule and it matters more here, because the
work happens minutes later in a sweeper with nowhere to complain to but a
column.

### What it is for

```sql
SELECT f.filename, c.page, c.text
FROM ingot_chunks c
  JOIN ingot_files f USING (file_id)
  JOIN contracts   k USING (file_id)
WHERE k.notice_days < 30 AND f._ingested_at > '2026-01-01'
ORDER BY array_cosine_similarity(c.text_vec, $q) DESC
LIMIT 10
```

A structured filter no vector store can express, ranked by a similarity no
warehouse can compute, over both tiers, in one round trip. Nothing was written
to make that work — it works because all three are tables.

Neighbour expansion needs no API surface either, which is why `/query` gained no
`window` parameter: `ordinal` makes it a self-join, and the caller picks the
width.

```sql
WITH hit AS (SELECT file_id, ordinal, array_cosine_similarity(text_vec,$q) s
             FROM ingot_chunks ORDER BY s DESC LIMIT 5)
SELECT c.* FROM ingot_chunks c JOIN hit USING (file_id)
WHERE abs(c.ordinal - hit.ordinal) <= 1
```

### The boundary, and two things that are not built

`/file` takes opaque bytes from anyone holding a key and hands them to a
decoder, so it is a boundary like `/query` is. The declared media type and the
sniffed bytes must **agree** — a declared type alone is a caller choosing which
decoder runs, and four sniffed bytes cannot tell a `.docx` from a `.pptx`
because every OOXML file is a zip. A filename never reaches a path: object keys
are built from an id this service generated. Multer's limit is the absolute
ceiling on what is buffered at all; `INGOT_MAX_UPLOAD_BYTES` is the number a
deployment chose.

**Only the text formats are parsed today** — `text/plain`, `text/markdown`,
`text/html`, `text/csv`. PDF and the three OOXML zips have names in the wire
contract and no parser behind them, so an upload of one is **refused at the
door** naming what this build reads, rather than accepted and abandoned in a
sweeper. `DocumentParser.handles` is what makes that honest, and adding a parser
is what removes the refusal.

Two things are worth writing down before anyone relies on this at volume:

- **One request can now queue a hundred thousand embeddings.** The backlog used
  to be fed by tool results a few rows at a time. `INGOT_EMBEDDINGS_CONCURRENCY`
  times the replica count is currently the only thing between a document dump
  and an unbounded bill, and the HPA scales on CPU — so a bulk upload adds pods
  and multiplies the fan-out exactly when it is worst. A per-memory in-flight
  bound is the obvious next thing.
- **A chunks table is the first table here that will realistically hit the
  no-index ceiling.** Brute-force cosine stops being a good trade somewhere in
  the low millions of rows per table; tool results reach that slowly and
  documents reach it in a few thousand files. Nothing above is wrong, but the
  persisted index tier stops being "the obvious next thing" and becomes a dated
  dependency the moment this is used in earnest.

## Receipts

An agent storing something now will want to find it later, in a session that
remembers nothing about this one. Ask for a receipt and `/add` hands back the
SQL:

```jsonc
POST /:account/:ingot/add
{ "table": "pr_files", "key": ["pr", "path"], "receipt": "schema", ... }
```

```jsonc
{
  "rowsAdded": 2,
  "receipt": {
    "batch": "batch_1508c8...",
    "query": "SELECT * FROM \"pr_files\" WHERE \"_batch\" = 'batch_1508c8...'",
    "key": ["pr", "path"],
    "items": [
      {
        "key": { "pr": 42, "path": "src/engine.ts" },
        "query": "SELECT * FROM \"pr_files\" WHERE \"pr\" = 42 AND \"path\" = 'src/engine.ts'",
      },
    ],
    "itemsTruncated": false,
    "table": { "name": "pr_files", "key": ["pr", "path"], "rows": 2, "columns": [] },
  },
}
```

Two grains, because there are two questions. `query` finds everything **this
call** wrote — keyed on the batch, which is our id: useful immediately and
meaningless a week later. `items` finds each row on **your** key, which still
means something next week and still matches after the same item is stored
again. Without a declared key, `items` falls back to `_row_id` — exact, but
opaque and only as durable as your memory of it.

Opt-in (`"receipt": "schema"`, default `"none"`) because it costs a read the
write does not need. `items` is capped at 100 with `itemsTruncated` saying so;
`query` always covers every row.

**The key is not enforced.** Nothing deduplicates on it and nothing refuses a
second row with the same key — declaring one says _this is what identifies the
thing_, so that a receipt can hand back a query which still finds it. Upserting
on the key is the obvious next step and is not built.

An enum rather than a boolean, and the members escalate — `none`, `schema`,
`summary` — each doing what the one before it does and more. They escalate in
cost too, which is the reason for the ladder: `schema` costs a read, `summary`
costs a model. Widening an enum is not a breaking change, so `summary` landed
without a new API version, where turning `receipt: true` into
`receipt: "full"` would have needed one.

## Receipts

`receipt: "full"` asks for the third rung: a model reads the tool result and
writes a précis of it and **the search term somebody would use to find it
again**, and all of that is embedded.

The second half is the point. An agent looking for something later has a vague
intention, not a schema — so matching its question against a _predicted
question_ beats matching it against a JSON blob.

```jsonc
POST /:account/:ingot/add
{ "table": "pr_files", "receipt": "summary", ... }
```

```jsonc
{
  "rowsAdded": 42,
  "receipt": {
    "batch": "batch_1508c8…",
    "query": "SELECT * FROM \"pr_files\" WHERE \"_batch\" = 'batch_1508c8…'",
    "summary": {
      "status": "pending",
      "table": "ingot_receipts",
      "model": "gpt-4.1-mini",
      "query": "SELECT \"summary\", \"search_term\", \"source_table\", \"row_count\" FROM \"ingot_receipts\" WHERE \"source_batch\" = 'batch_1508c8…'",
    },
  },
}
```

**The summary is not in that response and cannot be.** A model is a network
away and a row is meant to be queryable the instant `/add` returns, so the
receipt is queued and a sweeper writes it — usually within a minute. What comes
back is a promissory note, which is the same promise the rest of a receipt
makes: here is how to find this later. `status` is always `pending` here;
running the query is what tells you it arrived.

A receipt lands in `ingot_receipts`, **an ordinary table in your memory**, and that is
the whole design rather than an implementation detail. Being ordinary is what
gets it the overlay, the embedding sweeper, the roll-up into Parquet,
tombstones, `/query` over both tiers, and deletion with the memory — none of it
written a second time. The name carries the reserved prefix, so `SqlName.table`
refuses it and no caller's mapping can write there.

| column         |                                                                    |
| -------------- | ------------------------------------------------------------------ |
| `source_batch` | the `/add` this describes. Its key, and what a receipt queries on. |
| `source_table` | where that write went.                                             |
| `summary`      | what the result was. **Embedded.**                                 |
| `search_term`  | the question a future caller would ask. **Embedded.**              |
| `body`         | the tool result as text, truncated. **Embedded.**                  |
| `row_count`    | how many rows that write produced.                                 |
| `model`        | who wrote it.                                                      |

Three embedded columns rather than one concatenated blob, because they answer
differently-shaped questions and one field would answer all of them worse.
`search_term` ranks best against a real question; `summary` ranks well against
a description; `body` is the only one that still matches on an identifier the
model did not think to mention.

```jsonc
{
  "text": "the change that broke the migration",
  "table": "ingot_receipts",
  "column": "search_term",
}
```

A model that refuses is retried a few times and then given up on, loudly:
`ingot_receipts_abandoned` is the gauge, kept apart from `ingot_receipts_pending`
because they mean opposite things. A backlog clears; an abandoned receipt is a
caller holding a query that will stay empty for good.

## Delivering a receipt

Everything above is collected by polling: `/add` hands back a SELECT and you run
it when you want the answer. That is the right default — it needs no
registration, no retry policy and no endpoint of yours to be up — but it is a
poor fit for an agent that has moved on and would rather be told.

So a memory can nominate somewhere to push each receipt as it lands. One
strategy per memory rather than per `/add`, because the thing that wants telling
is the system holding the memory, not the individual call — a receipt written
for a request that finished an hour ago still reaches it.

```jsonc
// POST /api/v1/:account/:ingot/config
{ "delivery": { "t": "webhook", "endpoint": "https://acme.dev/hooks/ingot" } }

// or
{ "delivery": { "t": "rmq", "queue": "agent.receipts" } }

// off again — an omission means "leave it alone", so this is explicit
{ "delivery": { "t": "none" } }
```

The whole config comes back, and `/info` reports it, because a patch that
changed one field leaves you no way to see the rest. `configure_delivery` is the
same thing over MCP.

**A `webhook` endpoint is the one place a caller chooses where this service
opens a connection**, so it is a boundary rather than a format check. Absolute
`http`/`https` only; no credentials in the URL, which would end up in a log line
the first time a delivery failed; and loopback, link-local, private and CGNAT
literals are refused, along with the cloud metadata hostnames. A DNS name that
merely _resolves_ into one of those ranges is not refused — catching that means
resolving at configuration time and pinning at delivery time, and the cost of
getting it wrong is a self-hosted deployment that cannot deliver to a service in
its own cluster. Put an egress policy in front of this if you need the stronger
guarantee.

For `rmq` you name only the queue. The broker is the deployment's
(`INGOT_RABBITMQ_URL`) — a tenant naming a broker would be a tenant choosing
where this service opens an authenticated connection. A queue this deployment
cannot reach is refused on the call that configures it, naming the variable,
rather than accepted and then failing every delivery afterwards in a log the
caller cannot see.

### What arrives

One POST per receipt, or one persistent message on the queue. `Ingot-Batch`,
`Ingot-Event` and `Ingot-Attempt` are on the webhook's headers, and `messageId`
on the AMQP envelope, so a receiver can deduplicate without parsing the body.

The queue is declared with `assertQueue`, because publishing to the default
exchange with a routing key naming a queue that does not exist is _silently
discarded_ by AMQP — which is the one failure this whole design refuses to have.
It is declared once per connection rather than once per message, and what has
been declared is forgotten the moment the connection is: on a failed publish, on
shutdown, and on amqplib's own reconnect. A cache that outlived its connection
would reach the same silent discard by another route, since a broker replaced
underneath us is one that has none of the queues we declared.

```jsonc
{
  "event": "receipt.ready",
  "ingot": "ing_01H8Z…",
  "batch": "batch_1508c8…",
  "externalId": "call_42", // your own handle, or null
  "sourceTable": "pr_files",
  "summary": "…",
  "searchTerm": "…",
  "totalResults": 412,
  "query": "SELECT \"external_id\", \"summary\", … FROM \"ingot_receipts\" WHERE …",
  "model": "gpt-4.1-mini",
  "readyAt": "2026-09-06T11:02:04Z", // when it landed, stable across retries
  "attempt": 1, // anything higher is a redelivery
}
```

`query` is in there rather than only the ids, and it is the same string the
receipt handed back: a delivery that said "receipt ready for `batch_1508c8`" and
left you to reconstruct the SQL would be a second contract, and the two would
drift.

### At-least-once, and why it is an outbox

Delivery is **at least once**. Deduplicate on `batch` — `readyAt` does not move
between attempts, so the pair is stable.

The mechanism is worth stating, because both obvious alternatives are silently
wrong. A push sent from inside the transaction that wrote the receipt announces
state a rollback can still take away, and nothing outside Postgres rolls back
with it. A push sent after the commit, in process, is lost for good if the
process dies in the gap. Neither failure produces an error anybody sees.

So the intention to deliver is a row in `receipt_delivery_queue`, written **in
the same transaction as the receipt itself** — the two land together or not at
all — and `DeliveryWorker` sends it afterwards, outside any transaction. That is
the same three-step shape the receipt worker uses, and for the same reason: a
webhook is a network call, and holding a pooled connection across one spends ten
connections on background work while the foreground is trying to answer.

```
ClaimDelivery     tx ~1ms   leases the row, counts the attempt
  transport.deliver        no transaction, no connection
CompleteDelivery  tx ~1ms   out of the outbox
```

A written receipt wakes the worker on commit, so a receiver hears about it about
as fast as the model wrote it; `sweep-deliveries` on its minute tick is the
floor under a wake that never happened, and it is where every retry after the
first lives. That floor matters more here than anywhere else in the service —
the other queues fall behind because _we_ are slow, this one because somebody
else's endpoint is down, which lasts minutes and is the ordinary case.

The target and the body are both resolved **at enqueue** and stored on the row.
Moving your endpoint does not silently retarget deliveries already promised
somewhere, and a body rebuilt at send time would be re-reading rows a tombstone
or a roll-up may have moved since.

Ten attempts, then it is left alone, loudly. `ingot_deliveries_abandoned` is the
gauge and it is kept apart from `ingot_deliveries_pending` for the reason the
receipt gauges are. Note what an abandoned _delivery_ is not: the receipt is
written and the query you were handed still returns it. What was lost is the
telling.

| variable                    | default            |                                                          |
| --------------------------- | ------------------ | -------------------------------------------------------- |
| `INGOT_RABBITMQ_URL`        | unset              | The broker. Unset refuses `rmq` at config time.          |
| `INGOT_RABBITMQ_EXCHANGE`   | `''`               | The default exchange routes by queue name.               |
| `INGOT_DELIVERY_TIMEOUT_MS` | `10000`            | A receiver that has not answered by now is not going to. |
| `INGOT_DELIVERY_ATTEMPTS`   | `10`               | Roughly ten minutes of somebody else's outage, absorbed. |
| `INGOT_DELIVERY_USER_AGENT` | `ingot-receipts/1` | Sent on every webhook.                                   |

## Querying

```jsonc
{ "sql": "SELECT path, adds FROM pr_files WHERE pr = 42 ORDER BY adds DESC" }
{ "text": "the change that broke the migration", "table": "pr_files" }
```

Both keys together is the interesting mode: the embedding is bound as `$q` and
your own SQL can use it, so a hybrid search — a real WHERE clause, ordered by
meaning — is one round trip.

```sql
SELECT path, array_cosine_similarity(patch_vec, $q) AS score
FROM pr_files WHERE pr = 42 ORDER BY score DESC LIMIT 10
```

`patch_vec` is there to rank _by_ and never to read: an embedding is how this
service orders rows, not a fact anybody stored, and `/info` does not report one.
So no result carries an embedding — `SELECT *` returns exactly the columns the
schema promised, and a query whose only output is a vector is refused rather
than answered with rows that have nothing in them. This is by type, not by
name, so aliasing one does not get it out.

`at` is a DuckDB keyword, and so are a few other plausible column names. This
service quotes every identifier it emits; your own SQL is your own, so a column
called `at` has to be written `"at"`.

### Keyword search

Semantic search finds what a row _means_; sometimes the thing wanted is the row
containing `ECONNREFUSED`. That is DuckDB's `fts` extension, and every session
loads it — not only the ones that turn out to use it, because a caller cannot
load it themselves: the lockdown refuses `LOAD`, and it has to, since the same
statement reaches every other extension too.

Loaded is not indexed. An index is built per table, per session, from settings
the table carries:

```jsonc
// POST /:account/:ingot/config/notes
{ "fts": { "enabled": true, "stopwords": "none", "stemmer": "none" } }
```

```sql
SELECT id, fts_main_notes.match_bm25(_row_id, 'connection refused') AS score
FROM notes WHERE score IS NOT NULL ORDER BY score DESC
```

The settings live on the table rather than on the query because **the analysis
has to match at both ends**: an index built with the English stopword list,
searched by a term that kept its stopwords, ranks on tokens the index does not
contain — and reports that as no results rather than as a mistake. Storing them
in one place is what makes the two halves the same by construction. `/info`
reports what every table is set to, defaults included.

Four things worth knowing:

- **Off by default.** The index is built inside the session, over the whole
  table, on the query that searches it. Building one for every table of every
  memory would put that cost on queries that store no prose at all, so a caller
  asks for it once.
- **Only for a query that searches.** `match_bm25` is a macro in the index's
  own schema, so a query using it must contain the text `fts_main_<table>`. No
  mention, no index built — an ordinary SELECT and a roll-up pay nothing.
- **`stopwords` is an enum, and that is a boundary.** DuckDB reads a value it
  does not recognise as _the name of a table_ to read stopwords from. A free
  string here would be a caller choosing which table this service reads.
- **`ignore` defaults to discarding digits.** DuckDB's default, `(\.|[^a-z])+`,
  keeps lowercase letters and nothing else, so `error 500` and `error 404`
  index identically. Text where numbers matter wants `[^a-z0-9]+`.

Changing any of them rewrites nothing: the settings describe how the rows are
read, so the next query indexes the new way and the Parquet is untouched.

### The sandbox

**The query endpoint runs SQL from anyone holding a key**, so it is a security
boundary and treated as one. `test/application/sql-sandbox.test.ts` is the most
important test here. Two layers, in this order:

1. **The session is locked down** — `enable_external_access = false`, then
   `lock_configuration = true` — _after_ the tables are in memory and before
   any caller SQL runs. That refuses the filesystem, the network, another
   tenant's Parquet, and any attempt to turn either setting back on.
2. **The statement must be exactly one SELECT** — `extractStatements` for the
   count, `prepare().statementType` for the type, plus a leading-keyword check
   because DuckDB rewrites some `PRAGMA` statements into a select.

The second is **not** a second opinion. The lockdown does not contain
`ATTACH ':memory:'`: it touches no filesystem and no network, so nothing
refuses it, and once attached a caller can allocate freely. The statement check
is what stops that. Anyone tempted to delete it as redundant should read the
ATTACH case in the sandbox test first.

The leading-keyword half of it carries more weight now that `fts` is loaded:
`PRAGMA create_fts_index` is a statement a caller can otherwise reach, and it
builds tables over a whole column. What a memory indexes is decided through
`/config`, which knows what it is agreeing to; not through a query.

A query is bounded by a row cap, a byte cap, a memory limit, and a timeout the
service enforces itself by interrupting the connection — DuckDB has no
statement-timeout setting.

## Expiry

A memory scoped to one piece of work should not outlive it. Say how long at
creation and it deletes itself:

```jsonc
POST /:account/create
{ "name": "reviewing PR 42", "retainFor": "14d" }

→ { "id": "ing_7f2c…", "expiresAt": "2026-09-09T09:00:00.000Z" }
```

`30m`, `12h`, `14d`, `4w` — a whole number and a unit, bounded at a minute and
ten years. A duration rather than a timestamp because the question you are
actually asking is _how long_, and making you do date arithmetic to express it
is a way to get a memory that expires in 1970. A short grammar rather than a
count of seconds because `14d` cannot be misread by three orders of magnitude
and `1209600` can — and what is on the other end of that mistake is
irreversible.

Omit it and the memory is kept until something deletes it. `expiresAt` is
reported by `/create`, `/info` and the listing, so what you asked for is always
visible.

`reap-expired-ingots` does the deleting, every ten minutes. It is the only
thing in the service that destroys data nobody asked it to destroy right now,
and it is written accordingly: it dispatches the ordinary `DeleteIngot` rather
than a second delete path, caps itself at 25 memories a tick so a mistake stays
small and visible for several ticks, re-reads and re-checks each one
immediately before deleting, and logs a line per memory — deleting somebody's
data is not a thing to do quietly.

There is no way to extend a retention yet. A memory you want to keep should be
created without one; changing your mind means creating another and writing to
it. That is the obvious next thing to build.

## Forgetting

"Delete" means three things in a store whose base tier cannot be edited:

- **Rows** — `POST /:ingot/delete` with a SQL predicate. The predicate is
  resolved to `_row_id`s _now_ and those ids are recorded as tombstones. Every
  read filters them out; the next roll-up drops them for good. Resolving to ids
  rather than storing the predicate is what keeps the filter set finite — a
  memory deleted from a hundred times would otherwise carry a hundred WHERE
  clauses forever.
- **A table** — schema and all, which is how a mapping decision is undone.
- **A memory** — everything, including the bucket objects, which are removed
  after the transaction commits. An orphaned object costs money; a manifest
  pointing at files that are gone costs every future query.

Rows are append-only. An agent correcting a stored fact appends a new row and
tombstones the old one, which is the right constraint for a memory — what was
believed at the time is often the interesting part.

## MCP

Mounted at `/api/v1/:account/:ingot/mcp`, streamable HTTP, the same bearer key.
Tools: `describe`, `remember`, `query`, `recall`, `forget`, `drop_table`.

**It is another interface over the same `Dispatcher`, never a second
implementation** — the rule webhooks get in `CLAUDE.md`, applied to the other
direction. `test/application/mcp-parity.test.ts` asserts the two surfaces still
cover the same operations, with an explicit table for anything deliberately
one-sided.

Two details do most of the work:

- The connection is **scoped to one memory**, so the tools take no ids and a
  client pointed at one cannot address another.
- The **schema is read per connection and handed over as the server's
  instructions**, and also exposed as the `ingot://…/info` resource. A model
  asked to write SQL against a schema it cannot see will invent column names.

## Which models it thinks with

Two ports, chosen separately from the same set — `local`, `openai`, `gcp`.

```bash
INGOT_EMBEDDER=openai      # text to vectors
INGOT_SUMMARISER=gcp       # the précis a receipt asks for
```

**Two selectors rather than one, because they are two purchases.** Embedding is
a per-row cost paid once; a summary is an LLM call paid every time somebody
asks for one. A deployment that wants real semantic search should not be made
to buy the second to get the first — and one variable for both would have made
that impossible.

| provider | embeddings                        | summaries          | needs               |
| -------- | --------------------------------- | ------------------ | ------------------- |
| `local`  | hashed bag of words and bigrams   | extractive         | nothing             |
| `openai` | `text-embedding-3-small`, 1536d   | `gpt-4.1-mini`     | `OPENAI_API_KEY`    |
| `gcp`    | Vertex `text-embedding-004`, 768d | `gemini-2.5-flash` | `INGOT_GCP_PROJECT` |

Every model name and width above is a setting; those are the defaults.
`OPENAI_BASE_URL` retargets the OpenAI adapter, which is what makes an Azure
deployment, a gateway or a local vLLM the same adapter rather than a fourth
one. `gcp` takes no key for the reason the GCS driver takes none: the
credential is not ours to hold, and Application Default Credentials find it.

Three things worth knowing before configuring it:

- **A provider named without its credentials refuses to boot.** Same trade as
  `INGOT_STORAGE`, and the failure it avoids is quieter: falling back to the
  stand-in leaves a service that answers, accepts writes and returns receipts,
  every one of them written by a hash.
- **The vector width is declared, never discovered.** It is baked into every
  stored vector and into the `FLOAT[N]` column a query session builds, so
  changing it is a re-embed rather than a configuration change. Both adapters
  send it _and_ check what came back — a model returning a different width is
  refused, because a stored vector of the wrong width is dropped from every
  ranking rather than mixed in, which reads as "search got worse" and nothing
  else.
- **The prompt is shared, and so is the adapter.** Both live in
  `summariser.port.ts` with the shape they produce, so switching provider
  changes which model answers and not what it was asked. Receipts go through
  the [AI SDK](https://ai-sdk.dev) — one `ModelSummariser` over a provider,
  rather than one adapter per host — which is what lets the shape be a schema
  the provider is held to instead of a sentence asking it nicely for JSON.
  Embeddings do not: `embed` is two JSON endpoints and a declared width, and
  the width is the thing a library would take away.

The defaults are `local` on both: deterministic offline stand-ins, so the suite
and a laptop need no network, no key and no bill. They are enough to exercise
everything around them — the queue, the sibling Parquet, the roll-up, the
ranking SQL — and they are not semantic search. Both say so at boot.

## Background work, and the transaction it must not hold

All three background jobs — embedding, receipts and delivery — call somebody
else, and all three are split into **three commands with the call in the
middle**:

```
ClaimEmbeddings / ClaimReceipt / ClaimDelivery   tx ~1ms  lease the work
   embed / summarise / deliver                            no transaction, no connection held
SaveEmbeddings / WriteReceipt / CompleteDelivery tx ~2ms  store it, leave the queue
```

The first two call a model; the third calls a webhook or a broker. The argument
is identical either way, and the only difference is who is on the other end.

The reason is `Dispatcher.send`, which opens a Postgres transaction around
every command. That is exactly right when a command is the unit of change and
exactly wrong for work with a network call inside it: a single command that
claimed _and_ called a model would hold one of ten pooled connections for the
length of an LLM round trip, so a handful of concurrent receipts would starve
the requests this service exists to answer — while presenting as a database
problem.

So the sequencing lives in a service instead. `ReceiptWorker`, `EmbedWorker` and
`DeliveryWorker` dispatch the three commands and make the call between them,
which means:

- **A worker is never dispatched.** `PgUnitOfWork.run` joins an open scope
  rather than nesting, so calling one from inside a command would put all three
  steps back in the transaction the split exists to avoid. The sweepers call
  them directly.
- **A lease replaces the row lock.** `FOR UPDATE SKIP LOCKED` cannot span a
  claim that has already committed, so both queues carry `claimed_at`. It stops
  a second replica buying the same vectors, and it expires so a worker that
  died mid-call does not strand the work.
- **A receipt counts its attempt at claim time.** A worker killed by the very
  body it is describing never reaches a failure handler, so a counter written
  there would never move and that body would be retried for ever. Embedding
  deliberately has no such cap: a text left queued is a column that fills in
  late, where one given up on is a column empty for ever.

`receipt-transaction.test.ts` holds this up, and does it from a second
connection — an uncommitted claim is invisible to anybody else, so seeing the
lease set while the model is mid-call is proof the transaction closed first.
Its second case runs the same worker inside a transaction and watches the
assertion invert, which is what stops the first one passing vacuously.

### How fast it goes

Two bounds, and it is worth being precise about which does what, because for a
while one of them was doing the other's job by accident.

**`PASSES` bounds one drain** — 8 batches of 128 for embedding, 4 receipts, 32
deliveries. It is a _yield point_, not a rate limit: it stops one drain holding
a slot indefinitely against a large backlog. A drain that stops on it says so
(`Drained.more`), and both callers restart immediately — `BackgroundWork` books
another, and a sweeper keeps going within its own tick, up to the moment the
next tick would have started. Without that, a drain that stopped with the queue
still full waited out the sweep, so `PASSES` was silently a ceiling of one drain
a minute: 1,024 rows, or **four receipts**, however fast the model answered and
however many replicas were running. A single `/add` fanning out into five
thousand embeddable rows is one wake, so it got one drain and then waited.

**`CONCURRENCY` bounds how many drains of a kind run at once** — 2, 2 and 6.
This one _is_ a rate limit, and deliberately: it is the only thing standing
between a burst of writes and an unbounded burst of calls at whatever
`INGOT_EMBEDDER` names.

**It is per replica, and that is the number that matters in a cluster.** The
wake path takes no advisory lock — only the sweep does — so what your provider
sees is `CONCURRENCY × replicas`. At the chart's `maxReplicas: 10` that is
twenty concurrent embed drains and sixty concurrent deliveries, and since the
HPA scales on CPU, a write burst adds pods and multiplies the fan-out exactly
when load is highest. Pick the number against your provider's quota divided by
the replica ceiling, not against one pod. `ingot_embeddings_pending` is what
says you got it wrong — read with `max()`, never `sum()`, for the reason
`observability/README.md` gives.

Which is why it is configurable rather than baked in: the right number is a
quota divided by a replica ceiling, and neither of those lives in this
repository.

| variable                       | default |                                                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------- |
| `INGOT_EMBEDDINGS_CONCURRENCY` | `2`     | Concurrent embed drains, per replica.                                                 |
| `INGOT_RECEIPTS_CONCURRENCY`   | `2`     | Concurrent summariser calls, per replica.                                             |
| `INGOT_DELIVERIES_CONCURRENCY` | `6`     | Concurrent deliveries, per replica. Higher because each goes to a different receiver. |

Each is refused at boot below 1 or above 64 — the cap being a typo guard rather
than a limit worth having, since the real bound is a quota this service cannot
see. The chart exposes all three under `config.background`, and one line at boot
says what a pod is running with.

So the ceiling is now the model, not the timer:

```
embeddings ≈ CONCURRENCY × 128 / L   rows/sec per replica
receipts   ≈ CONCURRENCY / L         receipts/sec per replica
```

`L` is one call's latency, which `ingot_embedding_duration_seconds` and
`ingot_receipt_duration_seconds` already measure. The wake path takes no
advisory lock, so it multiplies by replicas; the sweep path does, so a backlog
with no incoming writes is drained by one replica at a time.

The Postgres pool is not the constraint and that is the whole point of the
split: a drain holds a connection for the few milliseconds of claim and save out
of every `L`, so ten workers against a pool of ten sit at a few percent duty
cycle rather than at capacity.

## Embedding

Columns marked `"embed": true` are embedded asynchronously: `/add` queues the
text and a sweeper works the queue. Deliberately not inline — a tool result
should be queryable the instant it is accepted, without waiting on a model that
may be a network away. A receipt's three columns go through the same queue,
because `ingot_receipts` is an ordinary table.

**`embed` is a property of the table, not of the call.** It sits in the mapping
beside `type` because the first `/add` naming a table is what declares that
table — there is no `CREATE TABLE` here — and it is stored on the column from
then on. Later writes to that column are embedded whether or not they repeat
the flag. That is the difference between it and `receipt`, which is per call
because it costs a model call every time.

### Turning it on later only works forwards

A column that had `embed` off can be widened to have it on, and this is the one
place where doing so is worth understanding before you rely on it.

**The rows already stored are not embedded, and nothing will embed them.** The
queue is filled by the write that produced the rows, so flipping the flag
covers everything from that point on and nothing before it — and rows already
rolled up into Parquet are not in the overlay to be found at all.

The failure is silent the whole way down. There is no error, and
`ingot_embeddings_pending` counts the queue rather than un-embedded rows, so it
reads zero while a semantic search over that table returns only what arrived
after the flip. If you need a table's history searchable today, drop it and
store it again.

**A backfill is planned** — a sweeper that finds rows under an embeddable
column with no vector, across both tiers, and queues them — at which point
widening becomes an ordinary configuration change. Refusing the widening
outright was the other option and was not taken: a table that can never gain a
searchable column is worse than one that gains it from now on, provided the
"from now on" is written down. This is it being written down.

There is **no HNSW index**. DuckDB's `vss` needs a persisted database file,
which this design deliberately does not have. Brute-force cosine over a
materialised table is the trade, and it stops being a good one somewhere in the
low millions of rows per table — at which point the answer is a persisted index
tier, not a bigger `ORDER BY`.

## Running it somewhere else

`apps/ingot/Dockerfile` builds the service. The context is the repository, not
this directory, because Ingot imports two workspace packages:

```bash
docker build -f apps/ingot/Dockerfile -t ingot .
```

Debian rather than Alpine, and that one is not a preference: `@duckdb/node-api`
is a native addon distributed as a glibc binary, and on musl it installs
happily and fails at the first `require` — a container that starts, passes its
readiness probe and cannot answer a single query. The image also bakes `httpfs`
in, because DuckDB fetches that extension rather than linking it statically and
a pod that has to go and get it mid-query fails its first query on any network
that does not allow the egress.

The schema travels with the image, so a migration is the same artefact as the
service it is migrating for:

```bash
docker run --rm -e DATABASE_URL=… ingot bun dist/database/migrate.js
```

Every migration is idempotent, so that applies all of them every time rather
than keeping a ledger — which is what makes it safe as a job that may be
retried, and safe against a database that is already current.

Two paths want mounted scratch space rather than the container's writable
layer, and one `emptyDir` over `/var/lib/ingot` covers both: `staging`, where a
GCS roll-up copies Parquet before uploading it, and `tmp`, where DuckDB spills
a query that outgrows its memory limit. The second is the one that bites under
a `readOnlyRootFilesystem`, at whatever size starts spilling.

### Where the Parquet goes

The one decision nobody can make on your behalf, so it is named rather than
inferred — `INGOT_STORAGE` is `filesystem`, `s3` or `gcs`. A driver that is
misconfigured **refuses to boot**, and so does a bucket variable set without a
driver to go with it. That used to be a warning and a fallback to local disk,
which is the worst available outcome for somebody else's deployment: a service
that boots, answers, accepts writes, and loses all of them on the next deploy.

| Driver       | Needs                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `filesystem` | `INGOT_DATA_DIR`. A node with a volume — or a bucket somebody else has mounted.                  |
| `s3`         | Bucket, key and secret. AWS, MinIO, R2, Ceph. `INGOT_S3_ENDPOINT` for the ones that are not AWS. |
| `gcs`        | `INGOT_GCS_BUCKET`, and nothing else.                                                            |

`gcs` takes one variable because the credential is not ours to hold:
Application Default Credentials find it — the metadata server under a workload
identity, `GOOGLE_APPLICATION_CREDENTIALS` pointing at a mounted key file, or a
developer's `gcloud auth application-default login`.

That driver is shaped by one fact worth knowing before you deploy it, and it
was found by running DuckDB rather than by reading about it:

> **DuckDB cannot write to GCS with a service account.** Its `gs://` support
> takes an HMAC interoperability key and nothing else — there is no credential
> chain for it — and the other way in, a bearer token on an `https://` URL, is
> read-only: `COPY … TO 'https://…'` answers _"Writing to HTTP files not
> implemented"_.

An HMAC key is a static secret somebody has to mint, mount and rotate, which is
exactly what a workload identity exists to remove. So the two directions are
split rather than forced through one credential. **Reads stay in DuckDB**, over
the XML API with a short-lived token installed as a scoped HTTP secret — which
keeps the property the engine rests on, that projections and filters are pushed
into the Parquet and the bytes never pass through this process. **Writes go
through the client library**: a roll-up copies to `INGOT_STAGING_DIR` and
uploads it. A compaction is a handful of large sequential files, so the round
trip through disk costs little, and it is the only thing that works.

Two claims hold that up, and both are in `scripts/spike-duckdb.ts` rather than
in the suite, because they need `httpfs` and `bun run test` is not allowed to
need the network: that a scoped bearer token authenticates a read, proved
against a local server that refuses one without it; and that `duckdb_secrets()`
redacts `bearer_token`. The second is load bearing rather than tidy — that
function is a table function, so a tenant's own `SELECT` can call it and it
passes every check the engine makes. If it ever stops redacting, one tenant's
query hands back a credential for everybody's Parquet.

If none of that appeals, `filesystem` pointed at a mounted bucket is a real
option: a GCS FUSE CSI volume authenticates with the same service account and
DuckDB then reads and writes ordinary files.

## Layout

```
src/
  contexts/
    accounts/     tenants, API keys, and the two global guards
    ingots/       the manifest: what tables exist and what shape they are
    records/      the write path: mapping, coercion, overlay, tombstones, roll-up
    query/        the read path: SQL, plaintext, hybrid
  engine/         DuckDB behind a port; the session recipe lives here
  storage/        ObjectStore port; filesystem, S3 and GCS adapters
  ai/             Embedder and Summariser ports; local, OpenAI and Vertex
  mcp/            another interface over the same commands
  sweepers/       roll-up, embedding backlog, receipt queue, expiry — and the
                  timer and advisory lock that run them
  shared/  observability/  database/  health/
```

Four layers per context, dependencies pointing inward, ports as
`interface X` + `export const X = Symbol('X')` in one file — the same shape as
`@forge/api`, and its README is the longer explanation of why.

Two pieces sit _below_ the contexts because more than one of them needs the
identical behaviour and they must not diverge: `SessionBuilder`, which assembles
a table from both tiers for the query path, the delete path and the roll-up
alike; and `OverlayModule`, which is global to break a real cycle between the
manifest and the rows it describes.

## What holds this up

`bun run typecheck`, `bun run lint` and `bun run test` all pass before anything
is done. Tests need `bun run db:up` from the root, which brings up Postgres and
MinIO.

They also need `fts` present on the machine — `bun run extensions`, once. Every
session loads it, so a machine that has never fetched one cannot run a query at
all; that fetch is the only thing in the suite that reaches the network, and it
is why the image bakes both extensions in rather than fetching them per pod.

| Test                  | What it catches                                                         |
| --------------------- | ----------------------------------------------------------------------- |
| `sql-sandbox`         | A way out of the query session. **Read it before touching the engine.** |
| `full-text`           | Search finding nothing because the index disagrees with the settings.   |
| `rollup-equivalence`  | The answers depending on when you ask.                                  |
| `route-accounts`      | A route with no `@Account()`. Fails closed.                             |
| `module-graph`        | A port bound in one module and injected in another.                     |
| `mcp-parity`          | The MCP surface forking from the HTTP one.                              |
| `schema-drift`        | Drizzle's schema and Postgres disagreeing.                              |
| `mapping`             | The DSL accepting something it should refuse.                           |
| `duckdb-engine`       | A DuckDB upgrade withdrawing something the design assumes.              |
| `storage`             | A deployment that thinks it configured a bucket and did not.            |
| `ai-settings`         | The same, for a model — plus a provider added without an adapter.       |
| `receipt-writing`     | A receipt promising a summary that never arrives.                       |
| `receipt-transaction` | A model called while a pooled connection is held.                       |
| `embedding-space`     | One memory's vectors written by two different models.                   |
| `payload-size`        | A token estimate that makes a large `/add` slow.                        |
| `bucket`              | `removePrefix` leaving most of a destroyed memory in the bucket.        |
| `metric-catalogue`    | A metric labelled by tenant — a slow, expensive leak.                   |

That last one matters more here than in a single-tenant service: a label
carrying an account, ingot or table name is one Prometheus series per tenant for
the whole retention window. Per-tenant detail goes on the span, where
`observe(op, detail, work)` puts it and where it costs nothing.

## Known limits

- **One query materialises whole tables into memory.** `INGOT_MAX_TABLE_ROWS`
  is the ceiling, and exceeding it is a clear error rather than a slow one.
  `getTableNames()` narrows to the tables a statement names — but it returns
  nothing for a `JOIN … USING (…)` and nothing for an unparseable query, and
  the two are indistinguishable, so an empty answer falls back to materialising
  everything. Wrong in the safe direction, always.
- **Vector search is brute force.** See above.
- **No webhook when a receipt lands.** `ReceiptNotifier` is called on every one
  and the only adapter logs. What is missing is a place for a caller to say
  where to deliver.
- **`@duckdb/node-api` is pinned exactly.** It is a native N-API addon; the
  `-r.N` suffix makes range matching a guessing game. `scripts/spike-duckdb.ts`
  runs the assumptions under both Bun and Node and should be re-run on upgrade.
- **Observability is copied from `@forge/api`, not shared.** The rules are
  identical and the code is duplicated. A third service is the moment to extract
  `packages/observability` — with a real reason rather than a guess about one.
- **No durable execution, deliberately.** `src/restate/` was copied from
  `@forge/api` too, and it was removed rather than kept: the only thing using it
  here was four cron chains, and no work item ever lived in it — the queues are
  Postgres tables claimed with `FOR UPDATE SKIP LOCKED` under a lease. What it
  contributed was a timer that survived a restart, a retry, and one chain across
  replicas, which is `src/sweepers/scheduler.ts` and an advisory lock. The
  moment that stops being enough is inbound webhooks, where a journalled retry
  of somebody else's delivery is worth a broker; `git log` has the integration
  to bring back.
