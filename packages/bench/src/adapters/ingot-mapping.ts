import type { ToolName } from '../corpus/stream.js';

/** The arguments Ingot's `remember` tool takes, minus the payload itself. */
export interface RememberMapping {
  readonly table: string;
  readonly rows?: string;
  readonly columns: Record<string, ColumnMapping>;
  readonly key?: readonly string[];
}

export interface ColumnMapping {
  readonly from?: string;
  readonly value?: string | number | boolean | null;
  readonly type: 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'DATE' | 'JSON';
  readonly embed?: boolean;
}

/** How the mapping for a tool's payloads is decided. */
export type MappingSource = (tool: ToolName, sample: unknown) => Promise<RememberMapping>;

const text = (path: string, embed = false): ColumnMapping => ({
  from: path,
  type: 'VARCHAR',
  ...(embed ? { embed: true } : {}),
});
const int = (path: string): ColumnMapping => ({ from: path, type: 'INTEGER' });
const stamp = (path: string): ColumnMapping => ({ from: path, type: 'TIMESTAMP' });
const json = (path: string): ColumnMapping => ({ from: path, type: 'JSON' });

/**
 * The hand-authored schemas: the ceiling for what Ingot can be given.
 *
 * This is the configuration a careful engineer would write once, knowing the
 * shape of each tool's output. It is *not* the realistic configuration — an
 * agent meeting a tool result for the first time has to invent this — which is
 * why `--mapping agent` exists and why both are reported. A benchmark that
 * gave Ingot hand-tuned schemas and the baselines a raw dump would be rigged,
 * and the gap between the two columns is the honest measure of how much of
 * Ingot's advantage survives an agent doing the work.
 *
 * One column is embedded per table that has prose in it, matching what the
 * baselines embed. The `ref` is always a plain column: it is the join key and
 * the thing retrieval is scored on, and embedding an opaque id would be
 * theatre.
 */
const AUTHORED: Record<ToolName, RememberMapping> = {
  'catalog.list_services': {
    table: 'services',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      name: text('$.name'),
      owner: text('$.owner'),
      tier: int('$.tier'),
    },
  },
  'catalog.list_files': {
    table: 'files',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      path: text('$.path'),
      service: text('$.service'),
      loc: int('$.loc'),
    },
  },
  'github.list_pull_requests': {
    table: 'pull_requests',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      number: int('$.number'),
      title: text('$.title', true),
      author: text('$.author'),
      state: text('$.state'),
      created_at: stamp('$.created_at'),
      merged_at: stamp('$.merged_at'),
      additions: int('$.additions'),
      deletions: int('$.deletions'),
      files: json('$.files'),
      labels: json('$.labels'),
    },
  },
  'ci.list_runs': {
    table: 'ci_runs',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      run_id: text('$.id'),
      pr: int('$.pr'),
      workflow: text('$.workflow'),
      status: text('$.status'),
      duration_sec: int('$.duration_sec'),
      started_at: stamp('$.started_at'),
      failed_step: text('$.failed_step'),
    },
  },
  'pagerduty.list_incidents': {
    table: 'incidents',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      incident_id: text('$.id'),
      title: text('$.title'),
      service: text('$.service'),
      severity: text('$.severity'),
      started_at: stamp('$.started_at'),
      resolved_at: stamp('$.resolved_at'),
      summary: text('$.summary', true),
    },
  },
  /**
   * The oversized one, and the schema is the whole argument.
   *
   * Every field a question asks about is a real column with a real type —
   * `level` filterable, `duration_ms` an INTEGER that can be ordered and
   * averaged, `status` a number rather than text. Nothing is embedded: these
   * rows are identifiers, levels and durations, and embedding `message` would
   * buy a ranking over eight repeated phrases while costing an embedding call
   * per line. That is the case `configure_table` exists to decline.
   */
  'logs.search': {
    table: 'logs',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      at: stamp('$.at'),
      level: text('$.level'),
      service: text('$.service'),
      route: text('$.route'),
      status: int('$.status'),
      duration_ms: int('$.duration_ms'),
      message: text('$.message'),
    },
  },
  'linear.search_issues': {
    table: 'issues',
    rows: '$.items[*]',
    key: ['ref'],
    columns: {
      ref: text('$.ref'),
      issue_id: text('$.id'),
      title: text('$.title', true),
      service: text('$.service'),
      state: text('$.state'),
      assignee: text('$.assignee'),
      created_at: stamp('$.created_at'),
      body: text('$.body'),
    },
  },
};

export const authoredMapping: MappingSource = async (tool) => {
  const mapping = AUTHORED[tool];
  if (!mapping) throw new Error(`no authored mapping for ${tool}`);
  return mapping;
};

/** Which tables are worth a keyword index, and on which columns. */
export const FTS_COLUMNS: Record<string, readonly string[]> = {
  pull_requests: ['title'],
  incidents: ['title', 'summary'],
  issues: ['title', 'body'],
};
