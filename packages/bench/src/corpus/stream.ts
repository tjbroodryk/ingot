import type { Ref, World } from './world.js';

/**
 * The corpus: the world as an agent would actually have received it — a
 * sequence of paginated tool results, each a blob of JSON with no schema
 * attached.
 *
 * This is the only view of the world any adapter is allowed to ingest. Every
 * adapter gets the identical array, so differences in the results are
 * differences in what each one does with the same bytes.
 */
export interface ToolResult {
  readonly id: string;
  readonly tool: ToolName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly producedAt: string;
  readonly result: unknown;
  /** Which world records this payload contains. Never shown to a model. */
  readonly refs: readonly Ref[];
}

export type ToolName =
  | 'catalog.list_services'
  | 'catalog.list_files'
  | 'github.list_pull_requests'
  | 'ci.list_runs'
  | 'pagerduty.list_incidents'
  | 'linear.search_issues'
  | 'logs.search';

/** Page sizes chosen to look like the APIs they imitate, not to be convenient. */
const PAGE_SIZE: Record<ToolName, number> = {
  'catalog.list_services': 100,
  'catalog.list_files': 40,
  'github.list_pull_requests': 25,
  'ci.list_runs': 40,
  'pagerduty.list_incidents': 10,
  'linear.search_issues': 20,
  // Not a page size. `logs.search` is the tool that does not paginate, which
  // is the entire point of it — a result that arrives whole and does not fit.
  'logs.search': Number.MAX_SAFE_INTEGER,
};

function* pages<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

export interface CorpusOptions {
  /**
   * Render the world as a corpus whose payload shape changes underneath the
   * agent. Off by default; `--drift` switches it on.
   *
   * The rest of this file models the friendly case, and says so: one shape per
   * tool, a `ref` on every record, every page of a tool byte-identical in its
   * keys to every other page, the whole thing stamped at a single `world.now`.
   * That is a relational database wearing JSON, and a benchmark run only over
   * it is asking whether SQL beats top-k on a corpus that was already a table.
   * It is the corpus most flattering to this project's claim, which is exactly
   * why it should not be the only one.
   *
   * Real tool results drift. A provider adds a field, renames one, changes a
   * unit, starts returning an object where a string used to be, hands back a
   * rate-limit body on the same endpoint that returns records. An agent stores
   * all of it, because it has no way to know which page it is on.
   *
   * The asymmetry that makes this worth measuring is Ingot's, not the
   * baselines'. `remember` has to commit to a column mapping — a name, a type
   * — before it has seen the last page. A vector store commits to nothing: it
   * embeds whatever bytes arrive and drift costs it a slightly different
   * neighbourhood. So this flag attacks the mechanism this project is built
   * on, and the expected result is that the Ingot columns fall and the
   * dense columns stay roughly flat.
   *
   * Two rules hold every drift below honest:
   *
   * - **Nothing is lost.** Every world record still appears exactly once, with
   *   its `ref`, and `corpusRefs` is unchanged. Drift makes questions harder
   *   to answer, never impossible — an adapter that notices the rename and
   *   converts the unit gets full marks. A drift that removed records would be
   *   scoring retrieval against evidence the corpus does not contain.
   * - **Every adapter gets the identical array, and can see all of it.**
   *   Drift happens here, once, upstream of every adapter. The second half of
   *   that is the harder rule and it cost this flag a drift: there was a fifth,
   *   a rate-limit body with no `items` in it, emitted on `ci.list_runs` to ask
   *   what `remember` does with a payload that has no records. It had to go.
   *   `flattenRecords` — the chunker every baseline shares — iterates
   *   `page.items ?? []`, so a payload with no `items` is invisible to the
   *   vector columns, while Ingot's `/add` rejects it outright with a 422 and
   *   the whole Ingot column is skipped rather than scored. A drift only one
   *   side can see does not make the benchmark harder; it makes the result a
   *   rigged loss, which is worth no more than a rigged win. Testing that
   *   payload honestly means changing what the baselines ingest too, and that
   *   is a different change from this one.
   */
  readonly drift?: boolean;
}

/**
 * How far into a tool's records its payload shape changes.
 *
 * Two fifths in, and keyed to the record rather than to the page. Keying it to
 * the page would be tidier — a clean "v1 pages, then v2 pages" — but it would
 * not fire at all on `catalog.list_services`, which is eight records in one
 * page and the table almost every `join` question goes through. Records within
 * one payload disagreeing about their own shape is also the more faithful
 * model: a listing endpoint returns rows written at different times, and the
 * migration was applied to the rows, not to the responses.
 *
 * Two fifths rather than a handful of stragglers because the question is
 * whether an adapter can hold two shapes at once, not whether it can spot a
 * rarity. Both shapes have enough records behind them to be found by anything
 * that looks.
 */
const DRIFT_AT = 0.4;

/** Whether the record at `at`, of `of`, is on the far side of the change. */
function drifted(at: number, of: number): boolean {
  return at >= Math.floor(of * DRIFT_AT);
}

export function buildCorpus(
  world: World,
  options: CorpusOptions = {},
): readonly ToolResult[] {
  const drift = options.drift ?? false;
  const results: ToolResult[] = [];
  let sequence = 0;

  const emit = (
    tool: ToolName,
    args: Record<string, unknown>,
    items: readonly { ref: Ref }[],
    payload: unknown,
  ): void => {
    sequence += 1;
    results.push({
      id: `tr-${String(sequence).padStart(3, '0')}`,
      tool,
      args,
      // Every result is stamped at the world's clock: the corpus is a snapshot,
      // not something that was gathered over time.
      producedAt: world.now,
      result: payload,
      refs: items.map((item) => item.ref),
    });
  };

  const paginate = <T extends { ref: Ref }>(
    tool: ToolName,
    items: readonly T[],
    args: Record<string, unknown>,
    /**
     * `at` is the record's index across the whole tool, not within its page,
     * because that is what {@link drifted} is keyed to. See `DRIFT_AT`.
     */
    strip: (item: T, at: number, of: number) => unknown,
  ): void => {
    let page = 0;
    let at = 0;
    for (const chunk of pages(items, PAGE_SIZE[tool])) {
      page += 1;
      const rendered = chunk.map((item, within) => strip(item, at + within, items.length));
      at += chunk.length;
      emit(tool, { ...args, page }, chunk, {
        page,
        page_size: PAGE_SIZE[tool],
        total: items.length,
        items: rendered,
      });
    }
  };

  // DRIFT: `owner` is renamed `owner_team` partway through. A pure rename —
  // same value, same null, nothing added or removed — aimed at the two places
  // it hurts most: `absence` asks which services have no owner, and half the
  // `join` category reaches a team through this column. A typed store that
  // mapped `owner` on the first records now has a second column holding the
  // rest of the answer, and `WHERE owner IS NULL` is true of every service
  // past the drift point whether or not it has a team.
  paginate('catalog.list_services', world.services, {}, (service, at, of) => ({
    ref: service.ref,
    name: service.name,
    // Present and null rather than absent: the corpus states the absence, so a
    // model that finds the record can answer. Omitting the key would make the
    // absence questions unanswerable rather than hard.
    ...(drift && drifted(at, of) ? { owner_team: service.owner } : { owner: service.owner }),
    tier: service.tier,
  }));

  // DRIFT: a foreign key arrives late. `service_ref` states what `service`
  // already implies — refs are `svc:` plus the name — so it invents no fact
  // and contradicts nothing; it is the single most common real schema change,
  // a provider finally giving you a proper key. The cost lands on ingest
  // rather than on any one question: a mapping fixed on the first page has no
  // column for it, and the join it would have made easy is available only on
  // the records that arrived after somebody stopped looking.
  paginate('catalog.list_files', world.files, {}, (file, at, of) => ({
    ref: file.ref,
    path: file.path,
    service: file.service,
    ...(drift && drifted(at, of) ? { service_ref: `svc:${file.service}` } : {}),
    loc: file.loc,
  }));

  paginate('github.list_pull_requests', world.pullRequests, { repo: 'acme/platform' }, (pr) => ({
    ref: pr.ref,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    state: pr.state,
    created_at: pr.createdAt,
    merged_at: pr.mergedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.files,
    labels: pr.labels,
  }));

  // DRIFT: `duration_sec` becomes `duration_ms`, and the values change with
  // the name.
  //
  // The worst of the five, deliberately. A rename alone announces itself — a
  // column goes missing and something breaks loudly. A rename carrying a unit
  // change is silent: `ORDER BY duration_ms DESC` over a table that quietly
  // holds both units returns a confident, well-formed, wrong answer, and the
  // `ordering` category is scored on exactly that ordering. It is the drift
  // most likely to turn this project's best column into its worst, which is
  // the reason it is in here.
  paginate('ci.list_runs', world.ciRuns, {}, (run, at, of) => ({
    ref: run.ref,
    id: run.id,
    pr: run.pr,
    workflow: run.workflow,
    status: run.status,
    ...(drift && drifted(at, of)
      ? { duration_ms: run.durationSec * 1000 }
      : { duration_sec: run.durationSec }),
    started_at: run.startedAt,
    failed_step: run.failedStep,
  }));

  // `cause` is dropped here deliberately — it is the question generator's
  // handle on the incident, and putting it in the corpus would hand the
  // semantic category away as a keyword match.
  paginate('pagerduty.list_incidents', world.incidents, {}, (incident) => ({
    ref: incident.ref,
    id: incident.id,
    title: incident.title,
    service: incident.service,
    severity: incident.severity,
    started_at: incident.startedAt,
    resolved_at: incident.resolvedAt,
    summary: incident.summary,
  }));

  // One result, however many lines. A real log search does not hand back
  // pages of ten, and a fixture that paginated this would be modelling a
  // kinder tool than the one that causes the problem.
  if (world.logs.length > 0) {
    paginate('logs.search', world.logs, { query: 'window:72h', paginated: false }, (line) => ({
      ref: line.ref,
      at: line.at,
      level: line.level,
      service: line.service,
      route: line.route,
      status: line.status,
      duration_ms: line.durationMs,
      message: line.message,
    }));
  }

  // DRIFT: `assignee` stops being a string and starts being an object.
  //
  // The type change, which is the one a column has no answer to. A name is a
  // name in both shapes and a model reading either record knows who it is;
  // `VARCHAR` does not, and whatever the store does with the object — reject
  // the row, stringify the JSON, widen to a struct — is a different answer to
  // `WHERE assignee IS NULL`, which is what the `absence` category asks.
  //
  // Null stays null in both shapes. Absence is the fact under test and turning
  // it into `{ id: null, name: null }` would be testing a second thing while
  // pretending to test this one.
  paginate('linear.search_issues', world.issues, { query: 'is:issue' }, (issue, at, of) => ({
    ref: issue.ref,
    id: issue.id,
    title: issue.title,
    service: issue.service,
    state: issue.state,
    assignee:
      drift && drifted(at, of) && issue.assignee !== null
        ? { id: issue.assignee, name: issue.assignee }
        : issue.assignee,
    created_at: issue.createdAt,
    body: issue.body,
  }));

  return results;
}

/** Every ref the corpus contains, which is every ref retrieval can be scored on. */
export function corpusRefs(corpus: readonly ToolResult[]): ReadonlySet<Ref> {
  return new Set(corpus.flatMap((result) => [...result.refs]));
}
