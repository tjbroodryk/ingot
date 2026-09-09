import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../src/run/report.js';
import {
  comparisonAxis,
  metaPathFor,
  observedTextOf,
  readRun,
  readRuns,
  writeMeta,
  type RunMeta,
} from '../src/run/store.js';

/**
 * Reading a paid-for run back off disk.
 *
 * The transcripts are the expensive half of this package and everything
 * downstream of them is meant to be replayable for free, so the read path is
 * worth asserting on: a run that cannot be re-opened is a run that has to be
 * bought again.
 */

const META: RunMeta = {
  runId: 'test-run',
  seed: 42,
  model: 'gpt-5-mini',
  effort: 'high',
  repeats: 1,
  perTemplate: 2,
  maxToolCalls: 12,
  concurrency: 1,
  embedder: 'text-embedding-3-small',
  mapping: 'authored',
  notes: [],
  logs: 0,
  drift: false,
  provider: 'foundry-gpt',
  thinking: true,
  warnings: [],
  adapters: ['hyperspell'],
};

const ROW = {
  runId: 'test-run',
  adapter: 'hyperspell',
  questionId: 'q-001',
  category: 'absence',
  repeat: 0,
  question: 'Which services have no owner recorded?',
  gold: { kind: 'set', values: ['svc:auth'] },
  answer: ['svc:auth'],
  submitted: true,
  stopReason: 'stop',
  correct: true,
  f1: 1,
  evidenceRecall: 1,
  evidencePrecision: 1,
  toolCalls: 2,
  failedCalls: 0,
  inputTokens: 100,
  outputTokens: 10,
  finalInputTokens: 90,
  ms: 500,
  calls: [
    { name: 'query', input: {}, output: 'first', ms: 10, failed: false },
    { name: 'query', input: {}, output: 'second', ms: 10, failed: false },
  ],
} as unknown as RunRecord;

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bench-store-'));
}

describe('a run on disk', () => {
  test('the sidecar is named from the transcript, never guessed', () => {
    expect(metaPathFor('results/2026-01-01-seed1.jsonl')).toBe(
      'results/2026-01-01-seed1.meta.json',
    );
  });

  test('reads back the provenance and every row', async () => {
    const dir = await scratch();
    const jsonl = join(dir, 'run.jsonl');
    await writeFile(jsonl, `${JSON.stringify(ROW)}\n${JSON.stringify({ ...ROW, repeat: 1 })}\n`);
    await writeMeta(jsonl, META);

    const stored = await readRun(jsonl);
    expect(stored.meta.seed).toBe(42);
    expect(stored.meta.perTemplate).toBe(2);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[1]?.repeat).toBe(1);
  });

  test('refuses a transcript whose provenance is missing', async () => {
    const dir = await scratch();
    const jsonl = join(dir, 'orphan.jsonl');
    await writeFile(jsonl, `${JSON.stringify(ROW)}\n`);

    // The failure mode this guards against is a published number nobody can
    // trace to a seed and a model, which is worse than no published number.
    expect(readRun(jsonl)).rejects.toThrow(/no .*orphan\.meta\.json/);
  });

  test('rebuilds what the tools handed back, the way the loop joined it', () => {
    expect(observedTextOf(ROW)).toBe('first\nsecond');
  });
});

/**
 * Splicing a new column into a table already paid for.
 *
 * The reason this is a function rather than a `cat` is that it is the easiest
 * way in the whole package to publish something that looks like a comparison
 * and is not — one column bought from a different model, at a different seed,
 * or with a different number of repeats behind its ±. So the assertions here
 * are mostly about what it refuses.
 */
describe('merging finished runs', () => {
  const write = async (
    dir: string,
    name: string,
    meta: Partial<RunMeta>,
    adapters: readonly string[],
    // Which questions each of those adapters answered in this file. One by
    // default, because most of these tests are about columns; a top-up run is
    // the same columns over different questions.
    questions: readonly string[] = ['q-001'],
  ): Promise<string> => {
    const jsonl = join(dir, `${name}.jsonl`);
    const rows = adapters.flatMap((adapter) =>
      questions.map((questionId) => JSON.stringify({ ...ROW, adapter, questionId })),
    );
    await writeFile(jsonl, `${rows.join('\n')}\n`);
    await writeMeta(jsonl, { ...META, runId: name, adapters, ...meta });
    return jsonl;
  };

  test('one file is read exactly as it was, with nothing added', async () => {
    const dir = await scratch();
    const only = await write(dir, 'solo', {}, ['hyperspell']);

    const merged = await readRuns([only]);
    expect(merged.meta.runId).toBe('solo');
    expect(merged.meta.warnings).toEqual([]);
  });

  test('joins the columns and says which run each came from', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector', 'hyperspell']);
    const extra = await write(dir, 'extra', {}, ['pinecone']);

    const merged = await readRuns([base, extra]);
    expect(merged.rows.map((row) => row.adapter)).toEqual(['vector', 'hyperspell', 'pinecone']);
    // Its own run, not either input's, because it is neither of them.
    expect(merged.meta.runId).toMatch(/^combined-seed42-/);
    expect(merged.meta.adapters).toEqual(['vector', 'hyperspell', 'pinecone']);

    const [warning] = merged.meta.warnings;
    expect(warning).toContain('assembled from 2 runs');
    expect(warning).toContain('`vector`, `hyperspell` from base');
    expect(warning).toContain('`pinecone` from extra');
  });

  /**
   * Reporting on part of a finished run.
   *
   * The case that made this necessary: `oracle` was retired after the run that
   * bought it, and a published table showing a column for an adapter that no
   * longer exists is a table nobody can reproduce. The rows keep it — they are
   * the record of what ran — and the report leaves it out.
   */
  test('keeps only the columns asked for, and says so in the provenance', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector', 'hyperspell']);
    const extra = await write(dir, 'extra', {}, ['pinecone']);

    const merged = await readRuns([base, extra], new Set(['vector', 'pinecone']));
    expect(merged.rows.map((row) => row.adapter)).toEqual(['vector', 'pinecone']);
    expect(merged.meta.adapters).toEqual(['vector', 'pinecone']);

    // The warning names the table's columns, not the file's. Naming a column
    // the reader cannot see would be worse than saying nothing.
    const [warning] = merged.meta.warnings;
    expect(warning).toContain('`vector` from base');
    expect(warning).not.toContain('hyperspell');

    // And the table says what it is not showing, because the warnings a merge
    // inherits were written when the run was bought and go on naming it.
    expect(merged.meta.warnings.join(' ')).toContain('also hold `hyperspell`');
  });

  test('refuses to report on a file that contributes no column', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector']);
    const extra = await write(dir, 'extra', {}, ['pinecone']);

    // Silently dropping the file would report a two-run merge as a one-run
    // table, warning and all.
    expect(readRuns([base, extra], new Set(['vector']))).rejects.toThrow(/no rows left/);
  });

  test('refuses runs that disagree about anything that moves a number', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector']);
    const other = await write(dir, 'other', { repeats: 3 }, ['pinecone']);

    // Not a comparison: a column bought once beside a column bought three
    // times is a difference in spread nobody chose.
    expect(readRuns([base, other])).rejects.toThrow(/repeats=3 where base has 1/);
  });

  test('an Ingot-only run makes no claim about the embedder, so it cannot clash', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector']);
    // What `cli.ts` records when no adapter in the run embeds locally: Ingot's
    // vectors are the server's, so the run built no embedder at all.
    const ingot = await write(
      dir,
      'ingot',
      { embedder: 'none (no local vector adapter in this run)' },
      ['ingot-rest'],
    );

    const merged = await readRuns([base, ingot]);
    expect(merged.rows.map((row) => row.adapter)).toEqual(['vector', 'ingot-rest']);
  });

  test('still refuses two runs that each name an embedder and disagree', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector']);
    const hashed = await write(dir, 'hashed', { embedder: 'hash-bow-v1' }, ['pinecone']);

    // The case the rule exists for: one column ranked lexically, the other
    // semantically, in a table about semantic search.
    expect(readRuns([base, hashed])).rejects.toThrow(/embedder="hash-bow-v1"/);
  });

  test('refuses a column that answers the same question in both files', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector', 'hyperspell']);
    const again = await write(dir, 'again', {}, ['vector']);

    expect(readRuns([base, again])).rejects.toThrow(/`vector` answers q-001 in both/);
  });

  /**
   * The top-up: the same columns, the questions they had not been asked.
   *
   * This is the merge that a column-wide rule would have refused, and it is
   * the one the question set growing makes necessary. Accuracy is a mean over
   * rows, so a mean over two disjoint halves is the mean over the whole — the
   * table is what one sitting would have produced, and the only thing that
   * differs is when the rows were bought.
   */
  test('joins the same columns over questions neither file duplicates', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector', 'hyperspell'], ['q-001', 'q-002']);
    const topUp = await write(dir, 'top-up', {}, ['vector', 'hyperspell'], ['q-003']);

    const merged = await readRuns([base, topUp]);
    expect(merged.rows).toHaveLength(6);
    expect(new Set(merged.rows.map((row) => row.questionId))).toEqual(
      new Set(['q-001', 'q-002', 'q-003']),
    );

    // And the reader is told, because a column finished across two sittings is
    // not the same claim as a column bought in one.
    const [warning] = merged.meta.warnings;
    expect(warning).toContain('`vector`, `hyperspell` from base on 2 questions');
    // Named once. The second run's columns are the same nine (here two), and
    // repeating them buries which questions came from where.
    expect(warning).toContain('the same columns from top-up on 1 question');
    expect(warning).toContain('finished across more than one sitting');
  });

  test('says nothing about sittings when the runs split by column instead', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', {}, ['vector'], ['q-001', 'q-002']);
    const extra = await write(dir, 'extra', {}, ['pinecone'], ['q-001', 'q-002']);

    const merged = await readRuns([base, extra]);

    const [warning] = merged.meta.warnings;
    expect(warning).not.toContain('sitting');
    expect(warning).toContain('`vector` from base;');
  });

  test('carries every input run’s own warnings through, once', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', { warnings: ['hash embedder'] }, ['vector']);
    const extra = await write(dir, 'extra', { warnings: ['hash embedder'] }, ['pinecone']);

    const merged = await readRuns([base, extra]);
    expect(merged.meta.warnings.filter((warning) => warning === 'hash embedder')).toHaveLength(1);
  });

  test('notes a concurrency difference rather than refusing over it', async () => {
    const dir = await scratch();
    const base = await write(dir, 'base', { concurrency: 1 }, ['vector']);
    const extra = await write(dir, 'extra', { concurrency: 5 }, ['pinecone']);

    // It moves the ms column, which is not published, so it is operator
    // detail rather than a reason to block a table.
    const merged = await readRuns([base, extra]);
    expect(merged.meta.notes.join(' ')).toContain('different concurrency');
  });
});

/**
 * The axis of a comparison, which is the merge's opposite.
 *
 * `readRuns` refuses when a setting disagrees, because as columns in one table
 * those runs are not a comparison of retrieval. `comparisonAxis` is the case
 * where the disagreement is the whole question — so it refuses the two
 * situations a merge is fine with, and the reasons are worth pinning: no
 * difference means there is nothing to measure, and two differences mean the
 * number belongs to neither change.
 */
describe('the axis two runs are compared across', () => {
  const meta = (extra: Partial<RunMeta>): RunMeta => ({ ...META, ...extra });

  test('names the one setting that differs', () => {
    const axis = comparisonAxis(meta({ runId: 'a' }), meta({ runId: 'b', drift: true }));
    expect(axis).toEqual({ field: 'drift', left: false, right: true });
  });

  test('works for any setting, not only drift', () => {
    const axis = comparisonAxis(meta({ runId: 'a' }), meta({ runId: 'b', mapping: 'agent' }));
    expect(axis.field).toBe('mapping');
  });

  test('refuses two runs that agree about everything', () => {
    expect(() => comparisonAxis(meta({ runId: 'a' }), meta({ runId: 'b' }))).toThrow(
      /nothing to compare them across/,
    );
  });

  test('refuses two changes at once', () => {
    expect(() =>
      comparisonAxis(meta({ runId: 'a' }), meta({ runId: 'b', drift: true, mapping: 'agent' })),
    ).toThrow(/differ in 2 settings/);
  });

  /**
   * `concurrency` is exempt from the merge's must-match list because it moves
   * only the `ms` column. It has to be exempt here for the same reason, or two
   * runs that differ only in how fast they were bought would render as a
   * comparison of nothing.
   */
  test('ignores concurrency, which moves no published number', () => {
    expect(() =>
      comparisonAxis(meta({ runId: 'a' }), meta({ runId: 'b', concurrency: 8 })),
    ).toThrow(/nothing to compare them across/);
  });
});
