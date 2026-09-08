import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../src/run/report.js';
import { metaPathFor, observedTextOf, readRun, writeMeta, type RunMeta } from '../src/run/store.js';

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
  embedder: 'text-embedding-3-small',
  mapping: 'authored',
  provider: 'foundry-gpt',
  thinking: true,
  warnings: [],
  adapters: ['oracle'],
};

const ROW = {
  runId: 'test-run',
  adapter: 'oracle',
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
