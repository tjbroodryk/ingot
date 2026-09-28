<div align="center">

<img src="apps/ingot-app/src/app/icon.svg" alt="Ingot" width="96" height="96" />

# Ingot

**Open-source memory for agents. Turn tool results or documents into strucutred memories.**

[Docs](https://ingotdb.dev/docs/) · [Why](https://ingotdb.dev/why/) ·
[Benchmarks](https://ingotdb.dev/benchmarks/) ·
[SDK](packages/sdk/README.md) · [Example agent](packages/examples/README.md)

[![test](https://github.com/tjbroodryk/ingot/actions/workflows/test.yml/badge.svg)](https://github.com/tjbroodryk/ingot/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/tag/tjbroodryk/ingot?label=release&sort=semver)](https://github.com/tjbroodryk/ingot/tags)
[![npm](https://img.shields.io/npm/v/@ingotdb/sdk?label=%40ingotdb%2Fsdk)](https://www.npmjs.com/package/@ingotdb/sdk)
[![license](https://img.shields.io/github/license/tjbroodryk/ingot)](LICENSE)
[![stars](https://img.shields.io/github/stars/tjbroodryk/ingot?style=social)](https://github.com/tjbroodryk/ingot)

**Your agent's memory lives in your Postgres and your bucket as Parquet files.**<br />
Every row can be read with SQL, searched via text, browsed in the dashboard, or opened with any tool that reads Parquet.

**No model calls by default.**<br />
Storing and querying runs without an API key. Embeddings, summaries and OCR are opt-in.

**A drop-in solution for tool result storage and document ingestion.**<br />
Each document type is chunked on its own boundaries: PDFs by page, slides by slide,<br />
Markdown and HTML by heading, CSVs into typed rows. <br/>
With Ingot you can query tool results and documents in one pass.

</div>
<hr/>

Before Ingot, an agent loop had two mainstream options: keep every tool result
in context and let the bill grow with each turn, or push them through RAG and
accept that top-k retrieval is lossy. 

Ingot keeps the results queryable instead,
so a multi-turn agent stays accurate without carrying everything in the prompt.
It aims to replace the store-and-search half of a typical RAG stack, and to get
more accurate answers while doing it.

## Quick start

Start a local server (needs [Bun](https://bun.sh) and Docker):

```bash
git clone https://github.com/tjbroodryk/ingot && cd ingot
bun install
cp apps/ingot/.env.example apps/ingot/.env
bun run db:up && bun run dev          # API on :3002, dashboard on :5174
```

Then store a tool result and query it back with
[`@ingotdb/sdk`](packages/sdk/README.md):

```ts
import { IngotFoundry, col, table } from '@ingotdb/sdk';

const foundry = new IngotFoundry({
  url: 'http://localhost:3002',
  account: 'dev',
  apiKey: process.env.INGOT_API_KEY, // from apps/ingot/.env
});
const ingot = await foundry.ingots.cast({ name: 'support', externalId: 'support' });

// How a tool's JSON becomes rows. `.embed()` makes a column searchable by meaning.
const tickets = table('tickets')
  .rows('$.items[*]')
  .columns({
    id: col.varchar('$.id'),
    title: col.varchar('$.title').embed(),
    status: col.varchar('$.status'),
    opened: col.timestamp('$.opened_at'),
  })
  .key('id');

// Whatever the tool returned, as-is.
await ingot.add(tickets, await searchTickets({ query: 'billing' }));

// Queryable as soon as add returns.
await ingot.query('SELECT status, count(*) AS n FROM tickets GROUP BY 1');

// `text` is embedded and bound as $q. Embeddings are filled in shortly after the write.
await ingot.query({
  sql: `SELECT id, title FROM tickets
        WHERE status = 'open' AND opened > now() - INTERVAL 7 DAY
        ORDER BY array_cosine_similarity(title_vec, $q) DESC LIMIT 5`,
  text: 'customer was charged twice',
});
```

To hand the same store to an agent, `ingot.mcp()` returns ready-made tools, or
point any MCP client at the ingot's `/mcp` endpoint.
[`packages/examples`](packages/examples/README.md) is a complete agent built on
the Vercel AI SDK.

## Benchmark

An agent answers the same questions about a synthetic engineering org (tickets,
PRs, CI runs, owners) through each memory. The questions include counts,
orderings, joins across tool results and plain semantic lookups.

<!-- bench:start -->
<!-- Written by `bun run bench --publish`. Edits here are overwritten. -->

| Memory                     | Accuracy | Context tokens | Tool calls |
| -------------------------- | -------- | -------------- | ---------- |
| `ingot-mcp`                | 97% ±2%  | 6,319          | 3.3        |
| `ingot-rest`               | 96% ±2%  | 3,815          | 2.8        |
| `raw-context`              | 90% ±3%  | 33,594         | 0.0        |
| `turbopuffer`              | 70% ±5%  | 39,327         | 7.4        |
| `vector`                   | 69% ±5%  | 46,732         | 8.0        |
| `pinecone`                 | 60% ±5%  | 39,274         | 7.4        |
| `control-same-store-top-k` | 40% ±5%  | 37,042         | 7.6        |

gpt-5-mini, 33 questions × 3 runs, seed 1, over 19 tool results (501 records). Run `2026-09-22T09-28-30-440Z-seed1`.
<!-- bench:end -->

`ingot-mcp` and `ingot-rest` are Ingot through its MCP and REST tools.
`control-same-store-top-k` is the same rows and vectors reached only through
top-k. `raw-context` puts the whole corpus in the prompt. The table is
rewritten by `bun run bench --publish`; the methodology, per-category results
and how to rerun it are in [`packages/bench`](packages/bench/README.md).

Throughput and latency under load are measured separately, with the k6 scripts
in [`apps/ingot/load`](apps/ingot/load/README.md).

## Why not standard RAG

Ingot doesn't sit inside a RAG stack. It replaces the part that stores and
finds, and leaves writing the answer to the model.

Everything a retrieval pipeline does before the model call is already here.
`/file` chunks per format. `"embed": true` queues a column and a sweeper works
it. `array_cosine_similarity` ranks by meaning, DuckDB's `fts` ranks by term,
and one SELECT can do both. `/mcp` is how an agent reaches all of it. So there
is no vector store standing beside this one — Pinecone and turbopuffer are
columns in `packages/bench`, over identical vectors, rather than things Ingot
is wired to.

What changes is the interface. A vector store offers `top_k(embedding)`; this
offers a hybrid of SQL and text search, with similarity and fuzzy rankings inside it.

```sql
SELECT f.filename, c.page, c.text
FROM ingot_file_chunks c
  JOIN ingot_files f USING (file_id)
  JOIN contracts   k USING (file_id)   -- typed rows out of the same PDFs
WHERE k.notice_days < 30 AND f._ingested_at > '2026-01-01'
ORDER BY array_cosine_similarity(c.text_vec, $q) DESC LIMIT 10
```

Top-k can't express that. Nor can it answer "how many times did this check
fail last month", because there is no chunk that question is similar to.
`packages/bench` measures whether that is worth the schema it costs, and
`control-same-store-top-k` is the column that could prove it isn't: the same
rows and the same vectors, reached only through top-k.

What goes in is different too. A RAG corpus is documents. Here the main way in
is `/add`, which takes an agent's own tool results and projects them into typed
columns; documents arrive through `/file` and land in the same tables.

Four things a mature retrieval stack has that this does not:

- **No generation.** Rows come back; the agent writes the answer.
- **No reranker and no query rewriting.** Hybrid means the SQL you wrote ranks
  on BM25 and cosine together, not that something fused them on your behalf.
- **No ANN index.** Brute-force cosine, which stops being a good trade
  somewhere in the low millions of rows per table.
- **A schema up front**, for `/add`. A vector store asks for none, and that is
  a real cost the benchmark does not put a number on.

"RAG" usually means two things at once: store documents so a model can find
them, and put the top k chunks in the prompt. Ingot does the first. The
benchmark exists to argue with the second.

## How it works

At its core, its just an LSM tree.

```
        /add ──────────────►  overlay        (Postgres, queryable instantly)
                                 ▲
       /file ─► parse ───────────┘  │
                                    │
                          roll-up sweeper    (every 5 minutes)
                                    ▼
       /query ◄── DuckDB ──►  base tier      (Parquet, in a bucket)
                    ▲               │
                    └───────────────┘
                  a query unions both
```

A document sent to `/file` is parsed into chunks and, if you asked, into typed
rows, and from there it takes exactly the path a tool result takes. There is no
separate document store. `ingot_files` and `ingot_file_chunks` are
ordinary tables in your ingot, which is what lets one SQL statement filter on a
number pulled out of a PDF and rank on the meaning of the paragraph beside it.
A page with no text layer — a scan, a photocopy — can be read by an engine
`INGOT_OCR` names, off unless you ask; every chunk that comes back that way
says which engine read it, so `WHERE ocr IS NULL` is still the text the
document itself contained.

Writes land in Postgres and are queryable the instant they are accepted. A
sweeper folds them into Parquet on a schedule, and a query returns the same
rows before and after the fold. Two tiers are only worth having if that holds;
`test/application/rollup-equivalence.test.ts` checks it. DuckDB is the engine
and never the store: each query gets a fresh in-memory instance, built from the
manifest, locked down, used once and thrown away.

## Configuration

Every setting is in `apps/ingot/.env.example`, with defaults filled in and the
rest left as empty placeholders. Ingot won't start without `DATABASE_URL`, a
base tier to write Parquet to, and `INGOT_AUTH`; the example file fills all
three for local use.

It also ships a working `INGOT_API_KEY` so the quick start just works. That key
is public; generate your own for anything else:

```bash
echo "ing_sk_$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
```

The settings you are most likely to change:

- **`INGOT_STORAGE`**: `filesystem`, `s3` or `gcs`. Where the Parquet base
  tier lives. A half-filled bucket config refuses to boot.
- **`INGOT_EMBEDDER`**: `local`, `openai` or `gcp`.
- **`INGOT_SUMMARISER`**: `local`, `openai` or `gcp`.

`local` for either is a deterministic offline stand-in, fine for development
and tests but not meant for real retrieval. The server logs a warning at boot
when it's using one.

## Deploying

Two images are published to `ghcr.io/tjbroodryk/ingot/{server,app}` from
`main` and from each release tag.

The server needs a Postgres and somewhere to put Parquet. Neither is optional,
and `INGOT_STORAGE` refuses to boot half-configured rather than quietly writing
the base tier to a container's writable layer. The server image listens on
`:3002`, serves metrics on `:9465`, runs as uid 1000, and wants an `emptyDir`
mounted over `/var/lib/ingot` for staging and DuckDB's spill.

The site image is nginx serving the dashboard. It forwards `/api/` to
`INGOT_API_URL`, read when the container starts, so one image works for any
deployment:

```bash
docker run -p 8080:8080 -e INGOT_API_URL=http://host.docker.internal:3002 \
  ghcr.io/tjbroodryk/ingot/app
```

Without it, `/api/` answers 502 and says which variable to set.

There is no separate worker or cron to set up. Background jobs run as timers
inside the server process, and each takes a Postgres advisory lock so only one
replica runs it at a time (`apps/ingot/src/sweepers/scheduler.ts`). Scale
replicas freely; the lock stops two pods rolling the same table into the same
generation.

A broker is optional and is only ever an _output_: set `INGOT_RABBITMQ_URL` and
an ingot can be pointed at a queue for its receipts to be delivered onto,
alongside the webhook transport that needs no infrastructure at all. Nothing in
the service reads from it, and the queue that decides what to send is a Postgres
table like the rest.

`/api/health` is version-neutral and is what a probe should point at. The
schema travels in the image (`apps/ingot/drizzle`), so a migration job is the
same artefact as the service it migrates for.

The site is a directory of files and can sit behind any CDN. It can never be
the reason the API is down.

### On Kubernetes

`charts/ingot` is the Helm chart used to deploy the required components.

```bash
kubectl -n ingot create secret generic ingot-secrets \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=INGOT_S3_ACCESS_KEY_ID='…' \
  --from-literal=INGOT_S3_SECRET_ACCESS_KEY='…'

helm install ingot oci://ghcr.io/<owner>/<repo>/charts/ingot --version <x.y.z> \
  -n ingot --set config.s3.bucket=my-ingot-bucket
```

Create the Secret first; the chart won't render without it. The chart checks
what the server would check at boot, so a missing database or a half-filled
`INGOT_STORAGE` fails `helm install` with the value's name instead of showing
up as the third CrashLoopBackOff. It won't guess a bucket or an Ingress host
for you either.

The migration is a `pre-install,pre-upgrade` hook running
`bun dist/database/migrate.js` out of the server image, so the schema is
current before a single new pod starts and a failure fails the release. Helm
deletes the previous Job first, which is the step a raw manifest needs by hand;
re-running is safe because every migration is idempotent and all of them are
applied every time.

The chart's `appVersion` is what its image tags fall back to, so a released
chart carries the images it was built against and there is one version to bump.

[The chart's README](charts/ingot/README.md) is the longer answer, and
`values.yaml` is commented throughout.

## Repository layout

```
ingot/
├── apps/
│   ├── ingot/          @ingot/server: the memory server (REST, /mcp, roll-up sweeper)
│   │   └── load/       k6 load tests
│   └── ingot-app/      @ingot/app: landing site, docs and dashboard (static Next.js)
├── packages/
│   ├── sdk/            @ingotdb/sdk: the published TypeScript client
│   ├── shared/         @ingot/shared: wire contract shared by the server and app
│   ├── versioning/     @ingot/versioning: date-based API versioning for the server
│   ├── examples/       example agents built on the SDK
│   └── bench/          the accuracy benchmark behind the table above
├── charts/ingot/       Helm chart
└── docker/             local Postgres init, migrations and Prometheus config
```

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the repository layout, running the
test suite, CI, building the images, and running the benchmark and load tests.

## License

[MIT](LICENSE)