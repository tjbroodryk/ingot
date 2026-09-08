import { readFile, writeFile } from 'node:fs/promises';
import { canonicalAdapter } from '../adapters/names.js';
import type { ReportHeader, RunRecord } from './report.js';

/**
 * What a finished run leaves on disk, and how to read it back.
 *
 * The transcripts are the expensive half of a run and they are already durable
 * — `cli.ts` appends each row as it is bought, so a run that dies at question
 * ninety keeps the eighty-nine that were paid for. What was *not* durable is
 * the provenance: seed, provider, model, effort, embedder, mapping. Those lived
 * only in memory until the report was rendered, so a run that died before the
 * end left rows nobody could publish and nobody could re-score, because neither
 * is meaningful without knowing what produced them.
 *
 * Hence the sidecar, written before the first question rather than after the
 * last. A number on the site that nobody can trace to a seed and a model is
 * marketing; this file is what keeps the difference true for a run that
 * crashed as well as one that finished.
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

/**
 * A run read back from disk.
 *
 * Refuses rather than improvises. A JSONL with no sidecar is a run from before
 * this existed, and the honest thing is to say so — inventing a plausible seed
 * and provider to get a publish out would produce exactly the untraceable
 * number the sidecar exists to prevent.
 */
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
    // A run carries the name its columns were bought under, for ever. A column
    // renamed since then is still the same column — same store, same tools,
    // same questions — and a table that showed it twice under two spellings
    // would be reporting a difference that does not exist. The transcript on
    // disk is left exactly as it was written: it is the record of what ran,
    // not a document to be brought up to date.
    .map((row) => ({ ...row, adapter: canonicalAdapter(row.adapter) }));

  if (rows.length === 0) throw new Error(`${jsonlPath} has no rows in it`);
  // The sidecar names the columns the run was asked for, including any it never
  // reached, so it needs the same treatment as the rows or a merge would report
  // a column under one name and list it under another.
  const adapters = meta.adapters.map(canonicalAdapter);
  return { meta: { ...meta, adapters }, rows: rows as readonly RunRecord[] };
}

/**
 * The settings two runs have to agree about before their columns can sit in
 * one table.
 *
 * Everything that could move a number: the corpus and questions (`seed`,
 * `perTemplate`, `logs`), the agent (`model`, `provider`, `effort`,
 * `thinking`, `maxToolCalls`), the vectors (`embedder`), who wrote the
 * mappings, and `repeats` — because the ± in the report is a function of how
 * many runs are behind each cell, and a column bought once beside columns
 * bought three times is a spread comparison nobody made on purpose.
 *
 * `concurrency` is deliberately absent. It moves only the `ms` column, which
 * the site does not publish, so refusing a merge over it would block a
 * perfectly good table for a number nobody is reading.
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
 * Several finished runs, read back as one table.
 *
 * Splicing a column into a published table is a real need and not a shortcut:
 * a new adapter arrives, and re-buying the nine columns beside it is hours and
 * real money for numbers nobody expects to move. It is also the easiest way to
 * publish something that looks like a comparison and is not — one column from
 * a Claude run beside eight from a GPT run, in a table headed "retrieval".
 *
 * So this is a merge that refuses rather than a `cat`. Every setting that
 * could move a number has to agree; no column may come from two files, since
 * nothing here can decide which of them the reader should see; and the fact
 * that the table was assembled from more than one run is written into
 * `warnings`, which is the half of the provenance the site puts in front of
 * every reader. A splice nobody can see in the output is the thing worth
 * preventing, not the splice.
 */
export async function readRuns(paths: readonly string[]): Promise<StoredRun> {
  if (paths.length === 0) throw new Error('no run files to read');

  const runs = await Promise.all(paths.map((path) => readRun(path)));
  const [base, ...rest] = runs as [StoredRun, ...StoredRun[]];
  if (rest.length === 0) return base;

  for (const run of rest) {
    for (const key of MUST_MATCH) {
      if (base.meta[key] === run.meta[key]) continue;
      // A run with no locally-embedding adapter in it built no embedder and
      // records so. That is the absence of a claim, not a conflicting one:
      // Ingot's vectors are the server's, so an Ingot-only run says nothing
      // about `text-embedding-3-small` and cannot disagree with a run that
      // does. Treating the two as a mismatch would refuse exactly the merge
      // this exists to allow — a new column beside a table already bought —
      // while still catching the case that matters, which is two runs that
      // each name an embedder and name different ones.
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
   * The cell, not the column, is what may not come from two files.
   *
   * A column-wide rule is the obvious reading of "no run may contradict
   * another", and it is too strong by exactly one useful case: a question set
   * that grew. When a template is added to the generator, buying the eight new
   * questions for the columns already in the table is the same arithmetic as
   * having bought them in the first sitting — accuracy is a mean over rows, and
   * a mean over two disjoint halves is the mean over the whole. What must never
   * happen is two files holding an answer to the *same* question by the same
   * adapter, because nothing here can decide which one the reader should see.
   *
   * So the key is (adapter, question). Repeats within one file are the point of
   * repeats; the same pair across two files is the ambiguity worth refusing.
   */
  const from = new Map<string, string>();
  const columnsOf = new Map<string, Set<string>>();
  const questionsOf = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const row of run.rows) {
      const cell = `${row.adapter} ${row.questionId}`;
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
  // decides how the provenance has to read: "these columns came from there" is
  // the wrong sentence for a table where one column's questions came from two
  // files, and the reader is owed the true one.
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
  const leading = columnsIn(base.meta.runId).join(' ');

  const contributed = runs.map((run, index) => {
    const columns = columnsIn(run.meta.runId);
    const asked = questionsOf.get(run.meta.runId)?.size ?? 0;
    const scope = toppedUp ? ` on ${asked} question${asked === 1 ? '' : 's'}` : '';
    // A top-up is the same nine columns twice, and naming all of them again
    // buries the one thing that sentence has to say — which questions came
    // from where — under a repeated list.
    const named =
      index > 0 && columns.join(' ') === leading
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

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Whether this run's `embedder` names a model or records that there was none.
 *
 * `cli.ts` writes the sentinel below when no adapter in the run embedded
 * locally. Matching on the prefix rather than the exact string because the
 * parenthetical is a human-readable explanation that may be reworded, and a
 * merge that started silently comparing embedders again because somebody
 * improved a message would be a bad way to find out.
 */
function namesEmbedder(meta: RunMeta): boolean {
  return !meta.embedder.startsWith('none');
}

/**
 * Everything the tools handed back on one run, rebuilt from its transcript.
 *
 * `loop.ts` scores retrieval on the tool outputs joined by newlines and stores
 * those same outputs on the row, so this is a reconstruction rather than an
 * approximation — but it is coupled to that join, and the two have to move
 * together.
 */
export function observedTextOf(row: RunRecord): string {
  return row.calls.map((call) => call.output).join('\n');
}
