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
 * Hand-authored schemas: the ceiling for what Ingot can be given. One embedded
 * column per table that has prose; `ref` stays a plain column, being the join
 * key retrieval is scored on.
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
  // Every queried field is a real typed column; nothing is embedded, since
  // these rows are identifiers, levels and durations.
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
