# The retrieval benchmark

What an agent can get back out, and what it costs to get it.

```bash
cd packages/bench
bun run bench --dry-run              # the corpus and the questions, spending nothing
bun run bench --adapters vector,raw-context
bun run bench --adapters ingot,control-same-store-top-k,vector,hyperspell,raw-context
bun run bench --adapters ingot,ingot-rest        # the same store, two interfaces
bun run bench --adapters vector,pinecone,turbopuffer   # the same vectors, three indexes
```

`--dry-run` is the place to start. It prints every question and every gold
answer without making a single API call, which is also the way to check that
the question set is not quietly shaped in anyone's favour.

## The claim under test

Ingot contains a vector index — `array_cosine_similarity` over an embedded
column, alongside DuckDB's BM25. So the question is not "structure instead of
embeddings". It is **whether typed rows and SQL, on top of the same
embeddings, retrieve better than the embeddings alone** — and, separately, what
each answer costs in context.

That is why `control-same-store-top-k` exists and why it is the most important column
in the table. It is the same store, the same rows and the same vectors, reached
only through top-k semantic search. If Ingot beats a vector store but
`control-same-store-top-k` beats it by the same margin, the win came from chunking,
not from structure, and the honest conclusion is a smaller one.

### The interface question

There is a second way to win that has nothing to do with the data model.

Over MCP, Ingot's tool names, descriptions and schema summary are written by
the server — by the people shipping the product, who have every reason to write
them well. `vector`, `pinecone`, `turbopuffer` and `hyperspell` get one
description hand-written in this repository, shared between them. So some share
of any Ingot win is that it ships better prompt copy,
and no single column can tell you how big that share is.

`ingot-rest` is that share, isolated. It is the same server and the same
application code — MCP's `query` and `recall` dispatch the identical
`QueryIngot` that `POST /query` does — reached over the REST API with a tool
surface authored in `src/adapters/ingot-rest.ts`, in the same voice and at the
same length as the baselines'. The schema still goes into the system prompt,
because `/info` costs no tool call either way, but the words are ours.

Neither column is the honest one alone:

- **`ingot-mcp`** is what an agent connecting to Ingot today actually gets. The
  product claim.
- **`ingot-rest`** is typed rows and SQL with the packaging removed, symmetric
  with `vector` and `hyperspell`. The substrate claim.

The gap between them is the result: how much of the advantage is the data model
and how much is the surface it is reached through. Report both, or report
neither — a table with only `ingot-mcp` in it cannot answer the question, and a
table with only `ingot-rest` in it just moves the thumb to the other side of the
scale, since then *we* are the ones writing Ingot's descriptions and nobody can
check whether we wrote them well or badly.

`control-same-store-top-k-rest` is the same ablation as `control-same-store-top-k`, for the
same reason.

### Is the vector baseline a strawman?

The obvious objection to `vector` is that it is ninety lines in this
repository, written by the people whose product it is there to lose to. So the
two hosted vector databases most likely to be on the other side of the argument
are columns too:

| | |
| --- | --- |
| `vector` | Brute-force cosine, in process. Exact. |
| `pinecone` | A hosted ANN index, the category's default answer. |
| `turbopuffer` | A hosted index built on object storage. |

All three are handed the **identical vectors** — the same embedding model, the
same record-level chunking, the same text — and reached through the **identical
`search` tool**, written once in `src/adapters/semantic-search.ts` and imported
by all of them along with `hyperspell`. A test asserts that they are
byte-identical, because four hand-written copies of a tool description are four
chances for one column to quietly acquire better prompt copy than the others
and have it show up in the accuracy column wearing retrieval's clothes.

That leaves exactly one difference between the three: how the nearest vectors
are found. Which means the expected result is that they land within noise of
each other, `vector` a shade ahead because it is exact where the other two
approximate — and that is the point of running them. If a hosted vector
database cannot beat brute-force cosine over the same embeddings, then what the
top-k rows cannot do is a property of top-k retrieval rather than of a baseline
chosen to be weak. A *large* gap in either direction is a bug in an adapter,
not a finding.

Two configuration choices are worth stating, because both could be argued the
other way and both were made against these columns' interest:

- **Neither store's own embedding model is used.** Pinecone's integrated
  inference would embed with `llama-text-embed-v2` and turbopuffer's with its
  own default, and either row would then differ from the rest of the table in
  two ways at once. One embedder across the whole table is the rule; see
  [fairness](#fairness).
- **turbopuffer's full-text index is off.** It will do BM25 alongside vectors
  if the schema asks for it, and switching it on would make that row a hybrid
  search while the other two stay dense-only. Hybrid retrieval is a real
  question and it deserves its own column, not a silent edge in this one.

## What is measured

| | |
| --- | --- |
| **Accuracy** | Exactly right, per category. No partial credit. |
| **Set F1** | Partial credit, for the questions whose answer is a set. |
| **Evidence recall** | Of the records that constitute the answer, how many came back through the tools. |
| **Evidence precision** | Of the refs the tools returned, how many were answer-bearing. The noise measure. |
| **Context tokens** | Input tokens on the final request: what the model had to read to answer. |

Context tokens is not a footnote. "Right answer" and "right answer for four
hundred tokens instead of forty thousand" are different claims, and in an agent
that answers a thousand questions a day the second one is the one that decides
whether the memory is usable at all.

### There is no LLM judge

Every category is machine-scorable by construction — counts, sets of refs,
ordered lists of refs. Nothing here is graded by a model. A judge is a second
model whose mistakes land in the same column as the retrieval failures being
measured, and leaving it out removes an argument that could never be settled
from the numbers.

### Evidence recall is not defined for every question

Aggregate questions are scored on the answer alone, and the report says so. A
correct count of thirty-seven pull requests *is* the evidence; demanding that
thirty-seven refs come back through the tools would score the cheapest correct
path — one `SELECT count(*)` — as a total retrieval failure. Getting this wrong
in the obvious direction would have flattered exactly the case Ingot is
supposed to win, which is why it is called out here rather than buried.

## The question set decides the result

Vector search structurally cannot do aggregation, negation, exact filtering or
ordering. It does well on "what did we learn about X". A question set skewed
either way writes the conclusion before the first run, so the report is always
per category and the mix is always visible:

| Category | Example | Why it is here |
| --- | --- | --- |
| `aggregate` | how many PRs touched `src/auth/` | A statistic over the whole corpus, not a lookup |
| `absence` | which services have no owner, which have no incident | There is no text to be similar to |
| `ordering` | the three longest CI runs | Requires a total order, not a neighbourhood |
| `join` | open PRs touching a file owned by the `infra` team | Two or three tool results, joined on an undeclared key |
| `semantic` | which incident was caused by … | The paraphrase shares no distinctive term with the write-up |
| `multi-hop` | which team owns the service with the most incidents | Two hops and an argmax |

`join` is where the corpus being *tool results* rather than documents starts to
bite. The easy half of the category is a predicate over one payload. The other
half is not: the team that owns a service is in `catalog.list_services`, the
path-to-service mapping is in `catalog.list_files`, and the change itself is in
`github.list_pull_requests` — three results, arriving at different times,
sharing nothing but a bare string in a field that nobody declared as a key. No
single record is similar to the question, because the record that would answer
it outright does not exist. Either retrieval brings back two disjoint sets and
the model joins them, or the store joins them before the model sees anything.

The same argument makes the `absence` category's anti-join — which services
have had no incidents — different in kind from its ownerless services. A null
`owner` is *stated* in the payload. "No incident" is stated nowhere: it is a
property of two results held together, and there is nothing for a
nearest-neighbour search to rank.

The `semantic` category is the one designed to be *hard for Ingot* and easy for
a vector store, and it is worth understanding how. Each incident is written up
with a distinct cause — "the connection pool was exhausted under sustained
write load" — and the question asks with a paraphrase that deliberately shares
no content word with it: "the database ran out of spare handles for new work".
A test asserts that no paraphrase ever appears in the corpus, because if one
leaked, BM25 would answer the category and it would stop measuring meaning.

`multi-hop` is thin — one or two questions per seed. Templates whose answer
would be ambiguous under a tie are skipped rather than scored against one of
several right answers, and multi-hop ties are common. Treat that column as
directional until there are more templates behind it.

## Where the questions come from

There is no annotation. A seeded generator builds a world of services, files,
pull requests, CI runs, incidents and issues; the corpus is that world rendered
as the paginated tool results an agent would actually have received; the gold
answers are computed from the world objects directly. Five hundred questions
therefore cost the same as five, and `--seed` regenerates all of it exactly.

The corpus is the only view any adapter is allowed to ingest, and every adapter
gets the identical array.

## The corpus is an assumption too

The question mix is policed above and the tool descriptions are policed below,
and until `--drift` existed nothing policed the corpus. It is the place the
thumb was actually resting.

Every tool emits exactly one shape. Every record carries a `ref`. Every page of
a tool has byte-identical keys to every other page, and `stream.ts` stamps the
whole thing at a single `world.now` — its own comment says the corpus is a
snapshot rather than something gathered over time. That is a relational
database wearing JSON. Asking whether SQL beats top-k over it is asking a
question half-answered by the fixture, and it is the fixture most flattering to
this project's claim.

`--drift` is the same world written down badly, the way a provider actually
writes things down:

| | |
| --- | --- |
| a field renamed | `owner` becomes `owner_team` partway through the services |
| a unit changed with the name | `duration_sec` becomes `duration_ms`, values converted |
| a type changed | `assignee` is a string, then `{id, name}` |
| a key arriving late | files gain `service_ref` only after the change |
| a body with no records | one `ci.list_runs` result that is a rate limit, not a page |

The asymmetry this attacks is Ingot's, not the baselines'. `remember` has to
commit to a column name and a column type before it has seen the last page. A
vector store commits to nothing — it embeds whatever bytes arrive, and drift
costs it a slightly different neighbourhood. So the expected result is that the
Ingot columns fall, the dense columns stay roughly flat, and the gap this
benchmark exists to show gets smaller. **That is the point.** A benchmark that
has only ever been run over the corpus its authors designed is not yet
evidence.

Two rules keep it a harder benchmark rather than a rigged one, and
`corpus.test.ts` holds both:

- **Nothing is lost.** Every world record still appears exactly once with its
  `ref`, the rate-limit body is a retry rather than a replaced page, and the
  renamed unit carries the converted value. Every question stays answerable —
  by an adapter that notices. A drift that dropped records would be scoring
  retrieval against evidence the corpus does not contain, which is a rigged
  loss and no more honest than a rigged win.
- **Both shapes are findable.** The change lands two fifths of the way through
  each tool's records, keyed to the record rather than the page — keyed to the
  page it would never fire on `catalog.list_services`, which is eight records
  in one page and the table most of the `join` category goes through. A drift
  visible on three rows in two hundred would be testing whether an adapter can
  spot a rarity, which is a different question.

`github.list_pull_requests` and `pagerduty.list_incidents` are left alone. A
corpus where every tool drifts is its own unrealistic fixture, and two clean
sources make the drifted ones harder to dismiss.

A drifted run is not comparable with an ordinary one and the harness will not
let you pretend otherwise: `drift` is in the header, in the sidecar, in the
published summary, in the merge's must-match list and in the page's own
provenance note — which states the one-shape-per-tool assumption on the
ordinary run too, since a caveat that appears only when the numbers are bad is
an excuse.

## Fairness

Everything below is a rule the harness enforces, not an aspiration.

- **Same model, same budget, same answer channel.** One agent loop
  (`src/agent/loop.ts`) serves every adapter. Only the tool list differs.
- **Same embedding model on both sides.** `BENCH_EMBEDDER` must match the
  server's `INGOT_EMBEDDER`. The offline hash stand-in ranks lexically, not
  semantically, so a run using it is refused unless you pass
  `--allow-hash-embedder`, and the report is stamped with a warning if you do.
- **Record-level chunking for the baselines.** A record boundary is a semantic
  boundary, so nothing is split mid-object. The baselines are given the best
  chunking available, not a strawman one.
- **`k` up to 50.** The vector adapters may return fifty records per call, so
  what they cannot do is a property of top-k retrieval rather than of a
  stingy default.
- **One search surface, shared by every top-k row.** `vector`, `pinecone`,
  `turbopuffer` and `hyperspell` import the same system note and the same tool
  from `src/adapters/semantic-search.ts`, and a test asserts they are
  identical. Only where the vectors live and how they are ranked differs. See
  [is the vector baseline a strawman?](#is-the-vector-baseline-a-strawman)
- **A hosted store is never asked to embed.** Pinecone and turbopuffer both
  offer server-side embedding; using it would put a second embedding model in
  the table and break the rule above.
- **Each run gets its own namespace.** Pinecone and turbopuffer are written to
  a namespace named for the run, so a shared account cannot leak one run's
  corpus into another's results — and because that namespace holds this run's
  vectors and nothing else, it is dropped on the way out. Hyperspell's store is
  account-wide with no such boundary, so that adapter filters instead of
  deleting; issuing bulk deletes against somebody's account is the worse
  failure mode.
- **Ingot's schema summary is passed through.** The MCP server hands it over at
  connect time and it costs no tool call. Withholding it to make the columns
  look more alike would benchmark a version of Ingot nobody ships.
- **Who wrote the tool descriptions is a column, not a silence.** Ingot's come
  from the server over MCP and from this repository over REST, and both are in
  the table. See [the interface question](#the-interface-question).
- **A control that cannot bound a question is skipped, not scored zero.**
  Marking that a failure would push an upper bound below the adapters it
  exists to bound. Those cells are `—` and the report says why.
- **Keyword search is switched on.** `configure_table` enables BM25 on the
  prose tables during ingest, because leaving a documented feature off would
  measure a crippled configuration.
- **Hyperspell answers with retrieval, not with its own model.** `answer:
  false` on every query. Otherwise the row measures Hyperspell's synthesis and
  the agent under test is no longer the same agent across columns.
- **One provider per run.** `--provider` is a property of a whole report, never
  of a column. Foundry and the first-party API differ in which features are GA,
  so a table whose columns came from both would be comparing platforms while
  claiming to compare retrieval. The provider is stamped into every report
  header for exactly this reason.
- **Repeats.** Agents are stochastic; `--repeats` defaults to 3. The ± in the
  report is a binomial standard error, and because repeats of one question are
  not independent it understates the spread. It is a guide to whether a gap is
  worth believing, not a p-value.

### The mapping question

`remember` needs a column mapping — something has to decide that
`$.items[*].duration_sec` is an `INTEGER`. If a human hand-writes perfect
schemas for Ingot while the baselines get a raw dump, the benchmark is rigged.

Both configurations are runnable and both should be reported:

```bash
bun run bench --mapping authored   # the ceiling: an engineer who knows the payloads
bun run bench --mapping agent      # the realistic case: the model decides, once per tool
```

Under `--mapping agent` the model is shown one sample payload per distinct tool
and proposes the table, the columns, the types and which column to embed —
which is the position an agent storing the first page of a paginated result is
actually in. The gap between the two columns is the honest measure of how much
of Ingot's advantage survives the hard part being done by a model.

## The controls

`raw-context` is cheap to run and it is what makes every other number
readable. It puts the entire corpus in the prompt and gives the model no tools:
the ceiling for a corpus that fits in the window, the honest reminder that for
small memories the right answer is often to skip retrieval, and the cost
baseline every other adapter should undercut by an order of magnitude. Without
it a table of percentages has no scale — nobody can tell whether 61% is close
to the ceiling or half of it.

Its limit is the window. In `--logs` mode the corpus does not fit, the request
is refused before inference, and a run at that size has no ceiling in the table
at all. That is a real gap and not a rounding error.

### The oracle, and why it is gone

There used to be a second control. `oracle` placed exactly the answer-bearing
records in the prompt and was described as perfect retrieval, which it was not.
It received the records that *constitute* an answer and never the ones that
establish **why** they are the answer. Those are the same set for "which
incidents on `auth` were sev1 or sev2" — the incident record carries both
fields, so the prompt contains its own proof. They are not the same set for
"which pull requests had a failing CI run": the answer is pull requests, the
proof is CI runs, and the oracle was handed the former without the latter.
Asked to assert what its prompt could not support, the model did the defensible
thing and answered nothing.

That made it a ceiling that sat *below* the columns it was meant to bound —
33% on the join category in the run that retired it, against 100% for
`ingot-rest`. A reader takes a gap like that for a finding, and the finding
would have flattered this project. Repairing it meant giving the oracle the
predicate's records too, which is a different control and a re-buy of the
column; `raw-context` already bounds the model with strictly more information
and needs no caveat, so the second control was removed rather than rebuilt.

## Running it

The deterministic parts — the generator, the gold answers, the scorer — are
covered by `bun test` and cost nothing. The runner is `bun run bench`, is not
part of `bun run test` at the repository root, and spends real money.

```
--seed N               World seed. The corpus and every gold answer follow from it.
--adapters a,b,c       ingot, control-same-store-top-k, ingot-rest, control-same-store-top-k-rest,
                       vector, pinecone, turbopuffer, hyperspell, raw-context
                       With --from, selects which of a finished run's columns
                       the report shows. The rows on disk are untouched.
--repeats N            Runs per question. (3)
--per-template N       Questions generated per template. (3)
--max-tool-calls N     Retrieval budget per question, identical for every adapter. (12)
--concurrency N        Agent runs in flight at once, within one adapter. (1)
--model ID             Model id, or on Azure the DEPLOYMENT name. (gpt-5-mini)
--provider NAME        anthropic | foundry-claude | foundry-gpt. (foundry-gpt)
--effort LEVEL         low | medium | high | xhigh | max  (high)
                       Adaptive thinking on Claude, reasoningEffort on GPT.
--no-thinking          Send no reasoning settings at all.
--drift                Render the corpus with a payload shape that changes
                       underneath the agent: a field renamed, a unit changed
                       with it, a string that becomes an object, a key that
                       arrives late, one body with no records. The world and
                       every gold answer are untouched and nothing is lost, so
                       every question stays answerable — by an adapter that did
                       not fix its schema on the first page. Not comparable
                       with a run without it.
--publish FILE         Also write the site's summary JSON here. It carries the
                       corpus as well as the scores — every source, its page
                       size, and one record verbatim — rebuilt from the seed,
                       so the page can say what the numbers were measured over.
--from A.jsonl,B.jsonl Report on finished runs instead of buying new ones.
                       More than one splices their columns into one table.
--rescore              With --from: run the scorer again over the transcripts.
--mapping MODE         authored | agent
--categories a,b       Restrict to these question categories.
--out DIR              Where the JSONL and the report are written. (results)
--allow-hash-embedder  Permit a run with the offline stand-in embedder.
--dry-run              Print the corpus and questions, spend nothing.
```

| Environment | |
| --- | --- |
| `AZURE_FOUNDRY_RESOURCE`, `AZURE_FOUNDRY_KEY` | Either `--provider foundry-*`; or `AZURE_FOUNDRY_BASE_URL` |
| `BENCH_AGENT_MODEL` | The deployment to use for `foundry-gpt`. Ignored for other providers |
| `ANTHROPIC_API_KEY` | Only with `--provider anthropic` |
| `BENCH_EMBEDDER` | `hash` or `openai` — must match the server's `INGOT_EMBEDDER` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | When `BENCH_EMBEDDER=openai`. Azure's v1 endpoint works here |
| `INGOT_URL` | `http://localhost:3002` |
| `INGOT_ACCOUNT` | `dev` |
| `INGOT_API_KEY` | The key the server was started with |
| `HYPERSPELL_API_KEY` | Only for `--adapters hyperspell` |
| `PINECONE_API_KEY` | Only for `--adapters pinecone` |
| `PINECONE_INDEX`, `PINECONE_CLOUD`, `PINECONE_REGION` | `ingot-bench`, `aws`, `us-east-1`. The index is created, serverless, at whatever width `BENCH_EMBEDDER` produces, and an existing one of the wrong width or metric is refused rather than silently used |
| `TURBOPUFFER_API_KEY` | Only for `--adapters turbopuffer` |
| `TURBOPUFFER_REGION` | `aws-us-east-1` — it is part of the hostname, and a namespace lives in one region. The default matches Pinecone's so the `ms` column is not reporting geography |

The Ingot adapters need a running server (`bun run db:up && bun run dev`).
`ingot-mcp` and `control-same-store-top-k` reach it over MCP, because the tool names, the
descriptions and the schema handed over at connect time are part of what an
agent gets; `ingot-rest` and `control-same-store-top-k-rest` reach the same store over
`/add` and `/query` with tools authored here. See [the interface
question](#the-interface-question) for why both are in the table.

`pinecone` and `turbopuffer` need nothing running and nothing set up beyond a
key: each run creates its own namespace, and drops it on the way out. Pinecone
additionally creates the index itself the first time, at whatever width the
configured embedder produces.

### Adding a column without re-buying the table

A new adapter arrives and the nine columns beside it have not changed. Buying
them again is hours and real money for numbers nobody expects to move, so
`--from` takes more than one run and splices them:

```bash
bun run bench --adapters pinecone,turbopuffer --concurrency 5
bun run bench --from results/OLD.jsonl,results/NEW.jsonl \
  --publish ../../apps/ingot-app/src/benchmarks/results.json
```

This is the easiest way to publish something that looks like a comparison and
is not, so the merge refuses rather than concatenates:

- **Every setting that could move a number has to match** — seed, per-template,
  repeats, tool-call budget, model, provider, effort, thinking, mapping,
  embedder, logs. A mismatch names the field and both values and stops.
  `concurrency` is exempt: it moves only the `ms` column, which is not
  published, and a note records it when the runs disagree.
- **No column may answer the same question in two files.** Which of the two a
  reader should see is not a thing the harness can decide. The rule is on the
  cell rather than the column, because the same column over *different*
  questions is the top-up below.
- **The table says it was spliced.** The merged run carries a warning naming
  which run each column came from, and warnings are the half of the provenance
  the site puts in front of every reader. Everything that decides a number was
  held equal, but the runs were bought at different times, and that is the
  reader's to weigh rather than ours to omit.
- **The merge is written out as its own run**, so what was published is one
  file that can be `--from`-ed again. The constituent runs are untouched.

### Adding questions without re-buying the table

The other direction, and the commoner one: a template is added to the
generator, and the published table is short by however many questions it
produced. `--questions-not-in` buys the difference.

```bash
bun run bench --adapters ingot-mcp,vector,… --concurrency 5 \
  --questions-not-in results/OLD.jsonl
bun run bench --from results/OLD.jsonl,results/NEW.jsonl \
  --publish ../../apps/ingot-app/src/benchmarks/results.json
```

The arithmetic is why this is allowed rather than a fudge: accuracy is a mean
over rows, so a mean over two disjoint halves of the question set is the mean
over the whole. The merged table is the one a single sitting would have
produced — check it if you like, by splitting a finished run in two on
`questionId` and merging it back, which reproduces the original report to the
decimal.

Two guards make it safe:

- **The question-defining settings have to match.** Question ids are positional
  — `q-026` is whatever the twenty-sixth question happened to be — so they only
  name the same question when `--seed`, `--per-template` and `--logs` agree.
  They are checked before anything is bought, because the failure otherwise is
  silent rather than loud.
- **The top-up says what it is.** The partial run carries a warning that it
  asked only the questions the older run had not, and the merged table adds
  that a column was finished across more than one sitting. Numbers over a
  handful of questions chosen because they were missing are a slice of the set,
  not a sample of it.

Appending templates to the *end* of the generator matters for the same reason:
inserting one renumbers every question after it, and ids that have silently
changed meaning make both this and `--rescore` wrong rather than refused.

### How long it takes, and what to do about it

A full run is 25 questions × 3 repeats × 10 adapters — around 730 agent runs.
Measured over real transcripts, one run averages 30 seconds, so serial that is
about six hours.

Almost none of it is retrieval:

```
tool time:   7.8s  ( 1% of wall)   54 calls, 144ms mean
model time:  539s  (99% of wall)
correlation(output tokens, wall ms) = 0.98
```

Wall time is token generation, and each question is up to fourteen *sequential*
model round-trips — one per tool call, each with a longer context than the last.
The adapters are not the bottleneck; a `query` round trip is 144ms.

So `--concurrency N` runs N questions in flight within an adapter, and the
speed-up is close to linear:

```bash
bun run bench --concurrency 8    # ~6 hours becomes ~45 minutes
```

It defaults to 1, because it costs two things worth deciding on rather than
inheriting:

- **The `ms` column.** Every row's latency was measured while the provider was
  serving other runs from the same benchmark. Accuracy, tokens and tool calls
  are untouched — each agent run is independent and sees the identical corpus —
  but latency is comparable within the report and not against a serial one. The
  report is stamped with the concurrency and warns about exactly this.
- **Your rate limit.** A Foundry deployment has a TPM ceiling, and the AI SDK's
  default two retries mean hitting it makes the run *slower* rather than
  failing it.

Ingest stays serial whatever this says: writes go in corpus order, one page at
a time, exactly as an agent would have produced them.

The other lever is `--effort`. At `high` the model spends 2,400–5,200 output
tokens a question, and dropping it cuts wall time close to proportionally —
fine while iterating, but the report stamps the effort because runs at
different efforts are not comparable.

Worth noticing in those numbers: `control-same-store-top-k` averaged 5,238 output
tokens against `ingot-mcp`'s 2,452, and took twice as long. That is not overhead.
Take away SQL and the model thinks twice as hard to compensate, which is a
result rather than a cost.

### What a run leaves behind

Three files in `--out`, named after the run:

| | |
| --- | --- |
| `<run>.jsonl` | One row per (adapter, question, repeat), with the full tool transcript. Appended as each row is bought. |
| `<run>.meta.json` | The provenance — seed, provider, model, effort, embedder, mapping, warnings. Written *before* the first question. |
| `<run>.md` | The report. Derived; safe to regenerate. |

The sidecar is written first on purpose. The transcripts are the expensive half
and they were always durable, but the provenance used to live in memory until
the report was rendered — so a run that died at question ninety left ninety
paid-for transcripts that nobody could publish, because a number nobody can
trace to a seed and a model is not a result.

With both on disk, everything downstream of the buying is free:

```bash
bun run bench --from results/<run>.jsonl                  # regenerate the report
bun run bench --from results/<run>.jsonl --publish FILE   # and the site's summary
bun run bench --from results/<run>.jsonl --rescore        # run the scorer again
```

`--rescore` rebuilds the corpus and the question set from the sidecar's seed,
replays the stored transcripts through `scoreRun`, and says how many verdicts
moved. It never writes to the `.jsonl` — the transcripts are the artefact and
the scores are derived from them. A question id in the rows that the seed no
longer generates is a hard failure rather than a skipped row, because scoring
an answer against a question it was never asked is worse than refusing.

It re-scores; it does not re-decide what should have been run. A run bought
under an older set of adapters still has those rows in it, and re-scoring will
score them as they stand. Use `--adapters` with `--from` to report on a subset
of the columns a file holds — how the `oracle` column was retired from the
published table without touching the transcript that bought it.

## Running it on Azure

Both halves can run on Azure, and they are independent choices.

**The agent — Foundry, and this is the default.** The harness runs on the AI
SDK, so a provider is a `LanguageModel` and nothing downstream of
`src/agent/model.ts` knows which one it has:

```bash
export AZURE_FOUNDRY_RESOURCE=your-resource   # https://{resource}.services.ai.azure.com
export AZURE_FOUNDRY_KEY=...
bun run bench --adapters raw-context --repeats 1 --per-template 1
```

`--provider foundry-gpt` (the default) points `@ai-sdk/openai` at
`/openai/v1`, which Foundry serves for GPT deployments. `--provider
foundry-claude` points `@ai-sdk/anthropic` at `/anthropic/v1` instead — the
Anthropic provider already sends `x-api-key`, which is the header Foundry wants
— but that needs a Claude model deployed on the resource, and a name that is
not a deployment returns `DeploymentNotFound` rather than anything about
models. **`--model` is a deployment name on Azure, not a model id.**

`--effort` maps to `reasoningEffort` on GPT and to adaptive thinking on Claude;
the OpenAI scale stops at `high`, so `xhigh` and `max` are clamped rather than
sent and rejected. Adaptive thinking is GA on the first-party API and *beta* on
Foundry, so if `foundry-claude` rejects it, `--no-thinking` drops the
reasoning settings — for the whole run, and the report says so, because a table
where some columns thought and others did not is measuring the wrong thing.

Microsoft Entra ID is the better credential than a key and the SDKs take a
token provider for it; wiring `@azure/identity` into `src/agent/model.ts` is a
few lines and deliberately not done for you.

**The embeddings — Azure OpenAI.** No code change at all. Azure's v1 endpoint
speaks the OpenAI API and accepts `Authorization: Bearer <key>`, which is what
both this harness and `apps/ingot/src/ai/openai-embedder.ts` already send, so
pointing both at it is purely configuration:

```bash
# apps/ingot/.env
INGOT_EMBEDDER=openai
OPENAI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1
OPENAI_API_KEY=...
INGOT_OPENAI_EMBEDDING_MODEL=your-deployment-name

# packages/bench
export BENCH_EMBEDDER=openai
export OPENAI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1
export OPENAI_API_KEY=...
export BENCH_EMBEDDING_MODEL=your-deployment-name
```

`model` is the *deployment* name on Azure, not the upstream model name, and the
two sides must name the same deployment or the run is comparing embedders. The
base URL must end in `/openai/v1` — a 404 usually means it does not. Both
embedders assert the returned vector width against the configured
`dimensions`, so a mismatched deployment fails loudly rather than writing
vectors that rank badly for reasons nobody can see.

## What this does not measure

- **Write cost.** Ingestion is timed but not scored. Ingot asks for a schema up
  front and a vector store does not, which is a real cost. `--drift` now prices
  the half of it that shows up later — what a schema fixed on the first page is
  worth once the payloads stop agreeing with it — but the tokens, the latency
  and the human or model attention that mapping takes are still unmeasured.
- **Freshness.** Every corpus is loaded once and queried; nothing measures a
  memory being written to while it is read.
- **Scale.** The default world is about five hundred records, which fits in a
  context window. That is deliberate — it is what makes `raw-context` a usable
  ceiling — but conclusions about a corpus a thousand times larger are not
  supported by it.
- **Anything about Hyperspell's other features.** The adapter uses
  `/memories/add` and `/memories/query` as its documentation describes them.
  Integrations, live querying and server-side synthesis are all out of scope.
