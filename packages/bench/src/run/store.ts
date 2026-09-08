import { readFile, writeFile } from 'node:fs/promises';
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
    .map((line) => JSON.parse(line) as RunRecord);

  if (rows.length === 0) throw new Error(`${jsonlPath} has no rows in it`);
  return { meta, rows };
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
