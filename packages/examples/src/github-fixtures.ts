// Canned responses in the shape of GitHub's REST API, trimmed to the fields
// the tables below read. Swap these for real `fetch` calls and nothing else changes.

// GET /repos/{owner}/{repo}/issues
export const issues = [
  {
    number: 412,
    title: 'Roll-up sweeper skips tables with a pending tombstone',
    state: 'open',
    user: { login: 'mara-k' },
    labels: [{ name: 'bug' }, { name: 'rollup' }],
    comments: 6,
    created_at: '2026-09-02T09:14:00Z',
    closed_at: null,
  },
  {
    number: 409,
    title: 'Document the $$ root path in the add mapping',
    state: 'open',
    user: { login: 'dev-okafor' },
    labels: [{ name: 'docs' }],
    comments: 1,
    created_at: '2026-08-29T16:40:00Z',
    closed_at: null,
  },
  {
    number: 401,
    title: 'Query times out on ingots with more than 200 Parquet parts',
    state: 'closed',
    user: { login: 'sam-lindqvist' },
    labels: [{ name: 'bug' }, { name: 'performance' }],
    comments: 11,
    created_at: '2026-08-18T11:02:00Z',
    closed_at: '2026-08-25T08:30:00Z',
  },
  {
    number: 396,
    title: 'Support XLSX uploads in /file',
    state: 'closed',
    user: { login: 'mara-k' },
    labels: [{ name: 'enhancement' }],
    comments: 4,
    created_at: '2026-08-10T13:55:00Z',
    closed_at: '2026-08-21T17:12:00Z',
  },
];

// GET /repos/{owner}/{repo}/pulls?state=all
export const pullRequests = [
  {
    number: 415,
    title: 'Fix tombstone check in the roll-up sweeper',
    state: 'open',
    draft: false,
    user: { login: 'mara-k' },
    head: { ref: 'fix/rollup-tombstones' },
    base: { ref: 'main' },
    created_at: '2026-09-04T10:20:00Z',
    merged_at: null,
  },
  {
    number: 404,
    title: 'Prune the Parquet manifest before building the query',
    state: 'closed',
    draft: false,
    user: { login: 'sam-lindqvist' },
    head: { ref: 'perf/manifest-prune' },
    base: { ref: 'main' },
    created_at: '2026-08-22T09:05:00Z',
    merged_at: '2026-08-25T08:28:00Z',
  },
  {
    number: 399,
    title: 'XLSX parser for /file',
    state: 'closed',
    draft: false,
    user: { login: 'mara-k' },
    head: { ref: 'feat/xlsx' },
    base: { ref: 'main' },
    created_at: '2026-08-14T15:31:00Z',
    merged_at: '2026-08-21T17:10:00Z',
  },
  {
    number: 398,
    title: 'Experiment: HNSW index for embedded columns',
    state: 'closed',
    draft: true,
    user: { login: 'dev-okafor' },
    head: { ref: 'spike/hnsw' },
    base: { ref: 'main' },
    created_at: '2026-08-12T12:00:00Z',
    merged_at: null,
  },
];

// GET /repos/{owner}/{repo}/actions/runs
export const workflowRuns = {
  total_count: 4,
  workflow_runs: [
    {
      id: 9001204,
      name: 'test',
      head_branch: 'fix/rollup-tombstones',
      status: 'completed',
      conclusion: 'failure',
      run_started_at: '2026-09-04T10:22:00Z',
      updated_at: '2026-09-04T10:31:00Z',
    },
    {
      id: 9000877,
      name: 'test',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      run_started_at: '2026-08-25T08:29:00Z',
      updated_at: '2026-08-25T08:38:00Z',
    },
    {
      id: 9000750,
      name: 'images',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      run_started_at: '2026-08-25T08:29:00Z',
      updated_at: '2026-08-25T08:44:00Z',
    },
    {
      id: 9000412,
      name: 'test',
      head_branch: 'feat/xlsx',
      status: 'completed',
      conclusion: 'failure',
      run_started_at: '2026-08-20T14:02:00Z',
      updated_at: '2026-08-20T14:12:00Z',
    },
  ],
};
