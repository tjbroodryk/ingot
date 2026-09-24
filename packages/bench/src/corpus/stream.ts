import type { Ref, World } from './world.js';

/**
 * The corpus: the world as a sequence of paginated tool results, each a blob of
 * JSON with no schema attached. Every adapter ingests the identical array.
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
  // Not a page size: `logs.search` does not paginate — one result, arriving whole.
  'logs.search': Number.MAX_SAFE_INTEGER,
};

function* pages<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

export function buildCorpus(world: World): readonly ToolResult[] {
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
      // Stamped at the world's clock: the corpus is a snapshot.
      producedAt: world.now,
      result: payload,
      refs: items.map((item) => item.ref),
    });
  };

  const paginate = <T extends { ref: Ref }>(
    tool: ToolName,
    items: readonly T[],
    args: Record<string, unknown>,
    strip: (item: T) => unknown,
  ): void => {
    let page = 0;
    for (const chunk of pages(items, PAGE_SIZE[tool])) {
      page += 1;
      emit(tool, { ...args, page }, chunk, {
        page,
        page_size: PAGE_SIZE[tool],
        total: items.length,
        items: chunk.map(strip),
      });
    }
  };

  paginate('catalog.list_services', world.services, {}, (service) => ({
    ref: service.ref,
    name: service.name,
    // Present and null, not absent: the corpus states the absence so it can be answered.
    owner: service.owner,
    tier: service.tier,
  }));

  paginate('catalog.list_files', world.files, {}, (file) => ({
    ref: file.ref,
    path: file.path,
    service: file.service,
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

  paginate('ci.list_runs', world.ciRuns, {}, (run) => ({
    ref: run.ref,
    id: run.id,
    pr: run.pr,
    workflow: run.workflow,
    status: run.status,
    duration_sec: run.durationSec,
    started_at: run.startedAt,
    failed_step: run.failedStep,
  }));

  // `cause` is dropped: it is the question generator's handle, and would leak
  // the semantic answer as a keyword match.
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

  // One result, however many lines — a real log search does not paginate.
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

  paginate('linear.search_issues', world.issues, { query: 'is:issue' }, (issue) => ({
    ref: issue.ref,
    id: issue.id,
    title: issue.title,
    service: issue.service,
    state: issue.state,
    assignee: issue.assignee,
    created_at: issue.createdAt,
    body: issue.body,
  }));

  return results;
}

/** Every ref the corpus contains. */
export function corpusRefs(corpus: readonly ToolResult[]): ReadonlySet<Ref> {
  return new Set(corpus.flatMap((result) => [...result.refs]));
}
