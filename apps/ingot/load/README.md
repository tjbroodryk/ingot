# Load tests

[k6](https://k6.io) scripts against a running Ingot. `brew install k6`, then:

```bash
docker compose up -d --wait                     # from the repo root
cd apps/ingot && cp .env.example .env && bun run dev

export INGOT_ACCOUNT=dev INGOT_API_KEY=ing_sk_…   # the pair from .env
bun run load:write     # the write path, ramping to 100 req/s
bun run load:read      # the read path, ramping to 50 concurrent
bun run load:mixed     # what an agent actually does
bun run load:depth     # query latency as the overlay grows
bun run load:tables    # multi-table.js
bun run load:swept     # swept.js
```

The scripts do not sign anyone up: they run as the account the target was
started with, so `INGOT_ACCOUNT` and `INGOT_API_KEY` must match its
environment, and k6 fails in `setup()` without them. They default to
`http://127.0.0.1:3002`; point them elsewhere with `INGOT_URL=https://…`.
`K6_VERBOSE=1` prints the body of anything that fails, which is the first thing
you want when a threshold goes red.

## Against a cluster

A port-forward is its own bottleneck at these rates, so `load/k8s/run.sh` runs
the script as a Job beside the deployment instead: stock `grafana/k6`, the
scripts mounted from a ConfigMap, the account and key taken from the release's
own ConfigMap and Secret. It streams the output and exits non-zero if a
threshold goes red.

```bash
bun run load:k8s mixed --vus 5 --duration 30s   # start small
bun run load:k8s write -e RATE=20 -e K6_VERBOSE=1
```

It takes `write`, `read`, `mixed`, `depth`, `tables` or `swept`. It targets
whatever `kubectl` is pointed at, and asks first (`LOAD_YES=1` skips that).
`NAMESPACE`, `RELEASE` and `SECRET` default to `ingot`, `ingot` and
`ingot-secrets`. A sealed deployment has one account, so the load lands in the
real one.

The scripts come from the git tag matching the deployed image, not from your
checkout, because they follow the API of the version they are aimed at.
`SCRIPTS_REF` picks another ref, and `SCRIPTS_REF=worktree` runs the files on
disk.

## What each one is for

**`write.js`** — `/add` under sustained arrival rate. There is no DuckDB and no
object store on this path: apply a mapping, coerce, insert JSONB. If it is slow,
one of those three is why. Arrival-rate rather than VUs, so offered load is
fixed and queueing shows up as latency instead of quietly throttling itself.

**`read.js`** — the path worth worrying about. Every query uses a _fresh
DuckDB instance_ — not a connection; the sandbox settings are instance-wide —
configured ahead of time by a small warm pool, then materialises the ingot's
tables from Parquet and the overlay, locks it down, and throws it away. That is a lot of work per request and it is
deliberate: it is what makes running a caller's own SQL safe. This says what it
costs and where it stops being linear.

**`overlay-depth.js`** — the measurement the two-tier design rests on. Ingot
bets that reads stay acceptable while rows sit in the overlay, and
`INGOT_ROLLUP_MIN_ROWS` is a number attached to that bet. This writes in steps
and queries at each one, so what comes out is the curve that says where the
threshold should actually be. **Run it with the roll-up sweeper held off** —
both variables set high — or the compaction happens underneath the measurement
and flattens the very curve it is trying to show.

The sweepers are timers inside the service now. Roll-up takes a Postgres
advisory lock before it runs (the queue sweeps do not), so the way to hold it
off is to take its lock first and keep the session open:

```bash
psql "$DATABASE_URL" -c 'SELECT pg_advisory_lock(342916608, -616380041)' -c 'SELECT pg_sleep(3600)'
```

Every roll-up tick then finds the lock held and skips its turn; ending the
session hands it back. The pair is `(classid, objid)` from
`src/sweepers/exclusive.ts` — the second number is the FNV-1a hash of
`roll-up-ingots`, which is why it is written out here rather than computed in
SQL.

**`multi-table.js`** — one ingot, tables added one at a time, queries only ever
against `t0` and `t1`. It checks that the tables a query never mentions cost it
nothing: up to 0.3.1 every table's overlay was read from Postgres before DuckDB
narrowed, and the curve rose about 5ms per table. Each stops at `ROWS=900`, under the
sweeper's 1000, so nothing needs holding off. `TABLES`, `FILES`, `REPEAT` and
`EMBED=1` tune it.

**`swept.js`** — the opposite case: tables filled past 1000 rows, waited on
until the sweeper rolls them up (polling `/pending`, up to `WAIT=660` seconds),
then queried. Every read comes from Parquet, so this is the one that shows the
Parquet cache — run it with `INGOT_PARQUET_CACHE_BYTES` unset or 0, then set.
It prints the first few queries apart from the rest, since the first read of a
file downloads it.

**`mixed.js`** — store, then read back through the query the receipt handed you,
with an occasional semantic recall. The other scripts isolate each path; this
one runs them together, because the interesting failure is contention between
them. Writes hold a Postgres connection, reads hold a DuckDB instance and a
chunk of memory, and the pool is sized at ten (`DATABASE_POOL_MAX`).

## Reading the results

k6 reports client-side latency. Ingot reports its own view at
`http://localhost:9465/metrics` — `ingot_http_request_duration_seconds`,
`ingot_query_session_duration_seconds` split by phase, and
`ingot_db_pool_connections{state="waiting"}`. When k6's number is much worse
than the server's, the gap is queueing; when `waiting` is above zero, requests
are queued on a connection rather than on Postgres, and that moves well before
latency does.

## A note on data

Each run casts a fresh ingot in the configured account, named after its script
(`k6 write load`, `k6 mixed load`, `k6 overlay depth`, …), so runs do not
collide and the data is easy to find afterwards. `DELETE
/api/v1/:account/:ingot` removes one along with its data.

Point them at the development database, not `ingot_test` — the suite truncates
that between assertions.

## What these have already found

The first `write.js` run sat at a steady 1.2% of 500s under concurrency: two
writes to a table that did not exist yet both created it and collided on the
`(ingot_id, name)` index, raising a constraint violation that aborted the
transaction. Nothing in the test suite went near it, because every test there
wrote one thing at a time. It is now `test/application/concurrent-add.test.ts`.
