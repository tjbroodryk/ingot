import { readFile, writeFile } from 'node:fs/promises';
import { canonicalAdapter } from '../adapters/names.js';
import type { ReportHeader, RunRecord } from './report.js';

/**
 * What a finished run leaves on disk. `cli.ts` appends rows as bought; this
 * sidecar carries the provenance (seed, provider, model, effort, embedder,
 * mapping) and is written before the first question, so a crashed run is still
 * reportable and re-scorable.
 */
export interface RunMeta extends ReportHeader {
  /** Needed to rebuild the identical question set when re-scoring. */
  readonly perTemplate: number;
  /** Which adapters the run was asked for, including any it never reached. */
  readonly adapters: readonly string[];
}

/** The sidecar for a given JSONL. One derived from the other, never guessed. */
export function metaPathFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

export async function writeMeta(jsonlPath: string, meta: RunMeta): Promise<void> {
  await writeFile(metaPathFor(jsonlPath), `${JSON.stringify(meta, null, 2)}\n`);
}

export interface StoredRun {
  readonly meta: RunMeta;
  readonly rows: readonly RunRecord[];
}

/** A run read back from disk. Refuses if the sidecar is missing rather than inventing provenance. */
export async function readRun(jsonlPath: string): Promise<StoredRun> {
  const metaPath = metaPathFor(jsonlPath);
  let meta: RunMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8')) as RunMeta;
  } catch {
    throw new Error(
      `no ${metaPath} beside ${jsonlPath}. Runs from before the sidecar existed carry no ` +
        'seed, provider or model, and a published number that cannot be traced to those is ' +
        'not a result. Re-run it, or hand-write the sidecar if you know what produced it.',
    );
  }

  const text = await readFile(jsonlPath, 'utf8');
  const rows = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunRecord)
    // A column renamed since it was bought reads back under its current name;
    // the transcript on disk is left as written.
    .map((row) => ({ ...row, adapter: canonicalAdapter(row.adapter) }));

  if (rows.length === 0) throw new Error(`${jsonlPath} has no rows in it`);
  // The sidecar's column names get the same canonicalisation as the rows.
  const adapters = meta.adapters.map(canonicalAdapter);
  return { meta: { ...meta, adapters }, rows: rows as readonly RunRecord[] };
}

/**
 * The settings two runs must agree on before their columns can share a table:
 * everything that could move a number, including `repeats` (it sets the ± in
 * each cell). `concurrency` is absent — it moves only the unpublished `ms`.
 */
const MUST_MATCH: readonly (keyof RunMeta)[] = [
  'seed',
  'perTemplate',
  'repeats',
  'maxToolCalls',
  'model',
  'provider',
  'effort',
  'thinking',
  'mapping',
  'embedder',
  'logs',
];

/**
 * Several finished runs read back as one table — a merge that refuses rather
 * than a `cat`: every number-moving setting must agree, no column may come from
 * two files, and the splice is recorded in `warnings`.
 */
export async function readRuns(
  paths: readonly string[],
  /**
   * Which columns to keep, if not all. For reporting on part of a finished run.
   * The rows on disk are untouched; dropping a column is a decision about what
   * to publish, not what happened.
   */
  keep?: ReadonlySet<string>,
): Promise<StoredRun> {
  if (paths.length === 0) throw new Error('no run files to read');

  const all = await Promise.all(paths.map((path) => readRun(path)));
  const runs = keep ? all.map((run) => onlyColumns(run, keep)) : all;

  // Columns the files hold but the table does not show, for the provenance line.
  const dropped = keep
    ? [...new Set(all.flatMap((run) => run.rows.map((row) => row.adapter)))]
        .filter((name) => !keep.has(name))
        .sort()
    : [];
  for (const run of runs) {
    if (run.rows.length === 0) {
      throw new Error(
        `${run.meta.runId} has no rows left once the columns were filtered. Nothing here can ` +
          'report on a run that contributes no column; drop the file rather than the columns.',
      );
    }
  }

  const [base, ...rest] = runs as [StoredRun, ...StoredRun[]];
  // A single file needs no merge but can still have been narrowed.
  if (rest.length === 0) {
    return dropped.length === 0
      ? base
      : { ...base, meta: { ...base.meta, warnings: [...base.meta.warnings, droppedNote(dropped)] } };
  }

  for (const run of rest) {
    for (const key of MUST_MATCH) {
      if (base.meta[key] === run.meta[key]) continue;
      // A run with no locally-embedding adapter records no embedder — an
      // absence, not a conflict — so skip the check unless both name one.
      if (key === 'embedder' && !(namesEmbedder(base.meta) && namesEmbedder(run.meta))) continue;
      throw new Error(
        `${run.meta.runId} has ${key}=${JSON.stringify(run.meta[key])} where ` +
          `${base.meta.runId} has ${JSON.stringify(base.meta[key])}. Columns from runs that ` +
          'disagree about that are not a comparison of retrieval — re-run one of them to ' +
          'match, or report them as two tables.',
      );
    }
  }

  /*
   * The key is (adapter, question), not the column. A question set that grew is
   * a valid top-up — accuracy is a mean over rows, so a mean over two disjoint
   * halves is the mean over the whole — but two files answering the same
   * (adapter, question) is an ambiguity worth refusing.
   */
  const from = new Map<string, string>();
  const columnsOf = new Map<string, Set<string>>();
  const questionsOf = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const row of run.rows) {
      const cell = `${row.adapter}\u0000${row.questionId}`;
      const already = from.get(cell);
      if (already && already !== run.meta.runId) {
        throw new Error(
          `\`${row.adapter}\` answers ${row.questionId} in both ${already} and ` +
            `${run.meta.runId}. Which of the two the table should show is not something this ` +
            'can decide for you; pass only the file holding the rows you meant.',
        );
      }
      from.set(cell, run.meta.runId);

      const columns = columnsOf.get(run.meta.runId) ?? new Set<string>();
      columns.add(row.adapter);
      columnsOf.set(run.meta.runId, columns);

      const asked = questionsOf.get(run.meta.runId) ?? new Set<string>();
      asked.add(row.questionId);
      questionsOf.set(run.meta.runId, asked);
    }
  }

  // Whether any column was completed across more than one sitting, which
  // decides how the provenance reads.
  const toppedUp = runs.some((run) =>
    runs.some(
      (other) =>
        other.meta.runId !== run.meta.runId &&
        [...(columnsOf.get(run.meta.runId) ?? [])].some((adapter) =>
          columnsOf.get(other.meta.runId)?.has(adapter),
        ),
    ),
  );

  const columnsIn = (runId: string): readonly string[] => [...(columnsOf.get(runId) ?? [])];
  const leading = columnsIn(base.meta.runId).join('\u0000');

  const contributed = runs.map((run, index) => {
    const columns = columnsIn(run.meta.runId);
    const asked = questionsOf.get(run.meta.runId)?.size ?? 0;
    const scope = toppedUp ? ` on ${asked} question${asked === 1 ? '' : 's'}` : '';
    // For a top-up, the same columns; naming them again would bury which
    // questions came from where.
    const named =
      index > 0 && columns.join('\u0000') === leading
        ? 'the same columns'
        : columns.map((adapter) => `\`${adapter}\``).join(', ');
    return `${named} from ${run.meta.runId}${scope}`;
  });

  const runId = `combined-seed${base.meta.seed}-${stamp()}`;
  const warnings = new Set(runs.flatMap((run) => run.meta.warnings));
  warnings.add(
    `This table was assembled from ${runs.length} runs with identical settings — same seed, ` +
      `model, provider, effort, budget and repeats. ${contributed.join('; ')}. Everything ` +
      'that decides a number was held equal, but the runs were bought at different times, ' +
      'so a column is only as comparable as the provider was stable between them.' +
      (toppedUp
        ? ' A column here was finished across more than one sitting: the question set grew, ' +
          'the questions it had not been asked were bought later, and its accuracy averages ' +
          'both together.'
        : ''),
  );
  if (dropped.length > 0) warnings.add(droppedNote(dropped));

  const notes = new Set(runs.flatMap((run) => run.meta.notes));
  const concurrencies = new Set(runs.map((run) => run.meta.concurrency));
  if (concurrencies.size > 1) {
    notes.add(
      `The merged runs had different concurrency (${[...concurrencies].join(', ')}), so the ms ` +
        'column compares columns that were measured under different load. Accuracy and tokens ' +
        'are unaffected.',
    );
  }

  return {
    meta: {
      ...base.meta,
      runId,
      adapters: [...new Set(runs.flatMap((run) => run.meta.adapters))],
      warnings: [...warnings],
      notes: [...notes],
    },
    rows: runs.flatMap((run) => run.rows),
  };
}

/**
 * Reconciles a narrowed table with inherited provenance: the warnings may still
 * name a dropped column, so this says what the table is not showing.
 */
function droppedNote(dropped: readonly string[]): string {
  const names = dropped.map((name) => `\`${name}\``).join(', ');
  return (
    `The rows behind this table also hold ${names}, which ${dropped.length === 1 ? 'is' : 'are'} ` +
    'not shown. Provenance above may still name that column: it was bought, and the transcript ' +
    'keeps it. Leaving it out of the table is a decision about what to publish, not about what ' +
    'happened.'
  );
}

/** One run, narrowed to the columns asked for. */
function onlyColumns(run: StoredRun, keep: ReadonlySet<string>): StoredRun {
  return {
    meta: { ...run.meta, adapters: run.meta.adapters.filter((name) => keep.has(name)) },
    rows: run.rows.filter((row) => keep.has(row.adapter)),
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Whether this run's `embedder` names a model or records that there was none.
 * Matches on the prefix because the parenthetical may be reworded.
 */
function namesEmbedder(meta: RunMeta): boolean {
  return !meta.embedder.startsWith('none');
}

/**
 * Everything the tools handed back on one run, rebuilt from its transcript.
 * Coupled to `loop.ts`'s newline join of the same outputs.
 */
export function observedTextOf(row: RunRecord): string {
  return row.calls.map((call) => call.output).join('\n');
}
