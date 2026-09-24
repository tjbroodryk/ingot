import { readFile, writeFile } from 'node:fs/promises';
import { canonicalAdapter } from '../adapters/names.js';
import { RECENT_SINCE } from '../corpus/world.js';
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
  // Runs from before `--scale` existed were all the ordinary corpus.
  const scale = meta.scale ?? null;
  return { meta: { ...meta, adapters, scale }, rows: rows as readonly RunRecord[] };
}

/**
 * The settings two runs have to agree about before their columns can sit in
 * one table.
 *
 * Everything that could move a number: the corpus and questions (`seed`,
 * `perTemplate`, `logs`, `scale`), the agent (`model`, `provider`, `effort`,
 * `thinking`, `maxToolCalls`), the vectors (`embedder`), who wrote the
 * mappings, and `repeats` — because the ± in the report is a function of how
 * many runs are behind each cell, and a column bought once beside columns
 * bought three times is a spread comparison nobody made on purpose.
 *
 * `concurrency` is deliberately absent. It moves only the latencies, so a
 * merge across it goes ahead and carries a published warning instead.
 */
export const MUST_MATCH: readonly (keyof RunMeta)[] = [
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
  'scale',
];

/**
 * The one setting two runs are being compared *across*.
 *
 * A merge and a comparison are opposites, and the difference is worth keeping
 * sharp. `readRuns` splices columns that were bought under identical
 * conditions, and refuses when a setting disagrees — the columns would not be
 * a comparison of retrieval. A comparison is the case that disagreement *is*
 * the question: the same columns, the same questions, one setting changed, and
 * the result is the difference rather than either table.
 *
 * Exactly one field, because two would confound it. A run that changed the
 * corpus and the model at once produces a number that belongs to neither
 * change, and the honest thing is to refuse rather than to render it with a
 * caveat nobody reads.
 *
 * Zero fields is refused too, and that is not pedantry: two runs that agree
 * about everything are a merge, and rendering them as a comparison would put a
 * column of zeroes on the page as though something had been measured.
 */
export interface ComparisonAxis {
  readonly field: keyof RunMeta;
  readonly left: unknown;
  readonly right: unknown;
}

export function comparisonAxis(left: RunMeta, right: RunMeta): ComparisonAxis {
  const differing = MUST_MATCH.filter((key) => left[key] !== right[key]);

  if (differing.length === 0) {
    throw new Error(
      `${left.runId} and ${right.runId} agree about every setting that could move a number. ` +
        'There is nothing to compare them across — if you meant to put their columns in one ' +
        'table, that is a merge: pass both to --from and drop --against.',
    );
  }
  if (differing.length > 1) {
    throw new Error(
      `${left.runId} and ${right.runId} differ in ${differing.length} settings: ` +
        `${differing.map((key) => `${key} (${JSON.stringify(left[key])} vs ${JSON.stringify(right[key])})`).join(', ')}. ` +
        'A comparison across two changes at once measures neither of them. Re-run one of them ' +
        'so that a single setting differs.',
    );
  }

  const field = differing[0] as keyof RunMeta;
  return { field, left: left[field], right: right[field] };
}

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
export async function readRuns(
  paths: readonly string[],
  /**
   * Which columns to keep, if not all of them.
   *
   * For reporting on part of a finished run — a column retired since it was
   * bought, or one being looked at on its own. Applied before anything else
   * reads the rows, so the provenance warning names the columns the table
   * actually shows rather than the ones the file happens to hold.
   *
   * The rows on disk are untouched, which is the point: dropping a column from
   * a report is a decision about what to publish, and rewriting the transcript
   * to match would turn it into a decision about what happened.
   */
  keep?: ReadonlySet<string>,
): Promise<StoredRun> {
  if (paths.length === 0) throw new Error('no run files to read');

  const all = await Promise.all(paths.map((path) => readRun(path)));
  const runs = keep ? all.map((run) => onlyColumns(run, keep)) : all;

  // What the files hold and the table does not show. Worth its own line
  // because the warnings a merge inherits are prose written when the run was
  // bought, and they go on naming a column after it is dropped — a reader
  // otherwise hunts a published table for a row that provenance promised.
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
  // A single file needs no merge, but it can still have been narrowed, and the
  // reader is owed the same sentence either way.
  if (rest.length === 0) {
    return dropped.length === 0
      ? base
      : {
          ...base,
          meta: { ...base.meta, warnings: [...base.meta.warnings, droppedNote(dropped)] },
        };
  }

  for (const run of rest) {
    const key = firstMismatch(base.meta, run.meta, MUST_MATCH);
    if (key === null) continue;
    throw new Error(
      `${run.meta.runId} has ${key}=${JSON.stringify(run.meta[key])} where ` +
        `${base.meta.runId} has ${JSON.stringify(base.meta[key])}. Columns from runs that ` +
        'disagree about that are not a comparison of retrieval — re-run one of them to ' +
        'match, or report them as two tables.',
    );
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
  const leading = columnsIn(base.meta.runId).join('\u0000');

  const contributed = runs.map((run, index) => {
    const columns = columnsIn(run.meta.runId);
    const asked = questionsOf.get(run.meta.runId)?.size ?? 0;
    const scope = toppedUp ? ` on ${asked} question${asked === 1 ? '' : 's'}` : '';
    // A top-up is the same nine columns twice, and naming all of them again
    // buries the one thing that sentence has to say — which questions came
    // from where — under a repeated list.
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
  // A warning rather than a note, because the latencies are published.
  if (concurrencies.size > 1) {
    warnings.add(
      `The merged runs had different concurrency (${[...concurrencies].join(', ')}), so the ` +
        'latencies compare columns that were measured under different load. Accuracy and ' +
        'tokens are unaffected.',
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

/** The first of `keys` two runs disagree about, or null. */
function firstMismatch(
  left: RunMeta,
  right: RunMeta,
  keys: readonly (keyof RunMeta)[],
): keyof RunMeta | null {
  for (const key of keys) {
    if (left[key] === right[key]) continue;
    // A run with no locally-embedding adapter in it built no embedder and
    // records so. That is the absence of a claim, not a conflicting one:
    // Ingot's vectors are the server's, so an Ingot-only run says nothing
    // about `text-embedding-3-small` and cannot disagree with a run that
    // does. Treating the two as a mismatch would refuse exactly the merge
    // this exists to allow — a new column beside a table already bought —
    // while still catching the case that matters, which is two runs that
    // each name an embedder and name different ones.
    if (key === 'embedder' && !(namesEmbedder(left) && namesEmbedder(right))) continue;
    return key;
  }
  return null;
}

/**
 * Finished `--scale` runs, as the points of one series.
 *
 * The same rules as a merge with `scale` as the one setting that has to
 * differ: two points at one scale would be two readings of the same x.
 * `repeats` may differ too, because each point's ± is computed from its own
 * runs. Returned in scale order. A point finished across several sittings is
 * merged with `--from A,B` first and passed here as the file that wrote.
 *
 * An ordinary run may stand in as the 1× point. Its corpus and gold answers
 * are identical to `--scale 1`'s, but its questions carry no date, and the
 * series says so rather than letting the wording change pass as memory.
 */
export function asSeries(runs: readonly StoredRun[]): readonly StoredRun[] {
  if (runs.length === 0) throw new Error('no run files to read');
  const points = runs.map((run): StoredRun => {
    if (run.meta.scale !== null) return run;
    const warning =
      `The 1× point is ${run.meta.runId}, an ordinary run spliced in rather than bought for ` +
      'this series. Its memory and gold answers are identical to a --scale 1 run, but its ' +
      `questions do not say "on or after ${RECENT_SINCE}" and every other point's do.`;
    return { ...run, meta: { ...run.meta, scale: 1, warnings: [...run.meta.warnings, warning] } };
  });

  const [base] = points as [StoredRun];
  const questionsOf = (run: StoredRun): string =>
    [...new Set(run.rows.map((row) => row.questionId))].sort().join(',');
  const seen = new Map<number, string>();
  for (const run of points) {
    const scale = run.meta.scale as number;
    const { runId } = run.meta;
    // Ids are positional and identical across scales, so the same ids are the
    // same questions. Different ones mean a point was bought with a different
    // --categories, and the line would move for that reason alone.
    if (questionsOf(run) !== questionsOf(base)) {
      throw new Error(
        `${runId} asked different questions from ${base.meta.runId}. Every point on a line ` +
          'has to ask the same ones; pass --categories to narrow the wider run to match.',
      );
    }
    const already = seen.get(scale);
    if (already) {
      throw new Error(
        `${already} and ${runId} are both at ${scale}×. A series has one run per scale; ` +
          'merge them with --from first if they are halves of one point.',
      );
    }
    seen.set(scale, runId);

    const key = firstMismatch(
      base.meta,
      run.meta,
      MUST_MATCH.filter((one) => one !== 'scale' && one !== 'repeats'),
    );
    if (key !== null) {
      throw new Error(
        `${runId} has ${key}=${JSON.stringify(run.meta[key])} where ${base.meta.runId} has ` +
          `${JSON.stringify(base.meta[key])}. Only the scale may change along a series, or ` +
          'the line measures two things at once.',
      );
    }
  }
  return points.sort((a, b) => (a.meta.scale as number) - (b.meta.scale as number));
}

/**
 * Runs that differ only in the model, for a model × memory grid. Kept in the
 * order given, since the page reads the first model as the smaller one.
 */
export function asMatchup(runs: readonly StoredRun[]): readonly StoredRun[] {
  if (runs.length === 0) throw new Error('no run files to read');
  const [base] = runs as [StoredRun];
  const questionsOf = (run: StoredRun): string =>
    [...new Set(run.rows.map((row) => row.questionId))].sort().join(',');

  const seen = new Set<string>();
  for (const run of runs) {
    const { runId, model } = run.meta;
    if (seen.has(model)) {
      throw new Error(
        `Two runs are both ${model}. Merge them with --from first if they are columns of one ` +
          'model’s run.',
      );
    }
    seen.add(model);
    if (questionsOf(run) !== questionsOf(base)) {
      throw new Error(
        `${runId} asked different questions from ${base.meta.runId}. Every cell has to ask the ` +
          'same ones; buy both with the same --categories.',
      );
    }
    const key = firstMismatch(
      base.meta,
      run.meta,
      MUST_MATCH.filter((one) => one !== 'model' && one !== 'provider'),
    );
    if (key !== null) {
      throw new Error(
        `${runId} has ${key}=${JSON.stringify(run.meta[key])} where ${base.meta.runId} has ` +
          `${JSON.stringify(base.meta[key])}. Only the model may change across a matchup.`,
      );
    }
  }
  return runs;
}

/**
 * The line that reconciles a narrowed table with its own provenance.
 *
 * Warnings are inherited from the runs that were merged, and they are prose
 * written when those runs were bought — so they go on naming a column after it
 * has been dropped from the report. Without this, a reader follows the
 * provenance to a row the table does not have and concludes the table is
 * hiding it.
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
