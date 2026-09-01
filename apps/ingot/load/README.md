# Load tests

[k6](https://k6.io) scripts against a running Ingot. `brew install k6`, then:

```bash
docker compose up -d --wait                     # from the repo root
cd apps/ingot && cp .env.example .env && bun run dev

bun run load:write     # the write path, ramping to 100 req/s
bun run load:read      # the read path, ramping to 50 concurrent
bun run load:mixed     # what an agent actually does
bun run load:depth     # query latency as the overlay grows
```

Point them elsewhere with `INGOT_URL=https://…`. `K6_VERBOSE=1` prints the body
of anything that fails, which is the first thing you want when a threshold goes
red.

## What each one is for

**`write.js`** — `/add` under sustained arrival rate. There is no DuckDB and no
object store on this path: apply a mapping, coerce, insert JSONB. If it is slow,
one of those three is why. Arrival-rate rather than VUs, so offered load is
fixed and queueing shows up as latency instead of quietly throttling itself.

**`read.js`** — the path worth worrying about. Every query builds a _fresh
DuckDB instance_ — not a connection; the sandbox settings are instance-wide —
configures it, materialises the ingot's tables from Parquet and the overlay,
locks it down, and throws it away. That is a lot of work per request and it is
deliberate: it is what makes running a caller's own SQL safe. This says what it
costs and where it stops being linear.

**`overlay-depth.js`** — the measurement the two-tier design rests on. Ingot
bets that reads stay acceptable while rows sit in the overlay, and the sweeper's
`MIN_OVERLAY_ROWS` is a number attached to that bet. This writes in steps and
queries at each one, so what comes out is the curve that says where the
threshold should actually be. **Run it with the roll-up sweeper held off**, or
the compaction happens underneath the measurement and flattens the very curve it
is trying to show.

The sweepers are timers inside the service now, each taking a Postgres advisory
lock before it runs, so the way to hold one off is to take its lock first and
keep the session open:

```bash
psql "$DATABASE_URL" -c 'SELECT pg_advisory_lock(342916608, -616380041)' -c 'SELECT pg_sleep(3600)'
```

Every roll-up tick then finds the lock held and skips its turn; ending the
session hands it back. The pair is `(classid, objid)` from
`src/sweepers/exclusive.ts` — the second number is the FNV-1a hash of
`roll-up-ingots`, which is why it is written out here rather than computed in
SQL.

**`mixed.js`** — store, then read back through the query the receipt handed you,
with an occasional semantic recall. The other scripts isolate each path; this
one runs them together, because the interesting failure is contention between
them. Writes hold a Postgres connection, reads hold a DuckDB instance and a
chunk of memory, and the pool is sized at ten.

## Reading the results

k6 reports client-side latency. Ingot reports its own view at
`http://localhost:9465/metrics` — `ingot_http_request_duration_seconds`,
`ingot_query_session_duration_seconds` split by phase, and
`ingot_db_pool_connections{state="waiting"}`. When k6's number is much worse
than the server's, the gap is queueing; when `waiting` is above zero, requests
are queued on a connection rather than on Postgres, and that moves well before
latency does.

## A note on data

Each script signs up its own account, slugged `load-<script>-<clock>`, so runs
do not collide and the data is easy to find afterwards:

```sql
DELETE FROM overlay_row WHERE ingot_id IN (
  SELECT id FROM ingot WHERE account_id IN (SELECT id FROM account WHERE slug LIKE 'load-%'));
DELETE FROM account WHERE slug LIKE 'load-%';
```

Point them at the development database, not `ingot_test` — the suite truncates
that between assertions.

## What these have already found

The first `write.js` run sat at a steady 1.2% of 500s under concurrency: two
writes to a table that did not exist yet both created it and collided on the
`(ingot_id, name)` index, raising a constraint violation that aborted the
transaction. Nothing in the test suite went near it, because every test there
wrote one thing at a time. It is now `test/application/concurrent-add.test.ts`.
