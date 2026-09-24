import { describe, expect, test } from 'bun:test';
import type { Category } from '../src/questions/questions.js';
import { corpusShape, publishable } from '../src/run/publish.js';
import type { ReportHeader, RunRecord } from '../src/run/report.js';

/**
 * The summary the site renders. A shape change here renders an empty table
 * rather than failing; `apps/ingot-app/test/benchmarks.test.tsx` asserts the
 * other end of the contract.
 */

const HEADER: ReportHeader = {
  runId: 'test-run',
  seed: 42,
  model: 'gpt-5-mini',
  effort: 'high',
  repeats: 2,
  perTemplate: 3,
  maxToolCalls: 12,
  concurrency: 1,
  embedder: 'text-embedding-3-small',
  mapping: 'authored',
  notes: [],
  logs: 0,
  provider: 'foundry-gpt',
  thinking: true,
  warnings: [],
};

const CATEGORIES: readonly Category[] = ['aggregate', 'absence', 'ordering'];

function row(over: Partial<RunRecord>): RunRecord {
  return {
    runId: 'test-run',
    adapter: 'ingot',
    questionId: 'q-001',
    category: 'absence',
    repeat: 0,
    question: 'which services have no owner?',
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
    inputTokens: 1000,
    outputTokens: 100,
    finalInputTokens: 800,
    ms: 1200,
    calls: [],
    ...over,
  };
}

describe('publishable', () => {
  test('averages per adapter and per category', () => {
    const published = publishable(
      HEADER,
      [
        row({ adapter: 'ingot', questionId: 'q-001', category: 'absence', correct: true }),
        row({ adapter: 'ingot', questionId: 'q-002', category: 'aggregate', correct: false, f1: 0 }),
        row({ adapter: 'vector', questionId: 'q-001', category: 'absence', correct: false, f1: 0 }),
        row({ adapter: 'vector', questionId: 'q-002', category: 'aggregate', correct: false, f1: 0 }),
      ],
      CATEGORIES,
    );

    const ingot = published.adapters.find((a) => a.name === 'ingot');
    const vector = published.adapters.find((a) => a.name === 'vector');

    expect(ingot?.accuracy).toBe(0.5);
    expect(ingot?.byCategory.absence).toBe(1);
    expect(ingot?.byCategory.aggregate).toBe(0);
    expect(vector?.accuracy).toBe(0);
    expect(published.run?.questions).toBe(2);
  });

  test('names only categories the run actually asked about', () => {
    const published = publishable(
      HEADER,
      [row({ category: 'absence', questionId: 'q-001' })],
      CATEGORIES,
    );

    // `ordering` and `aggregate` had no questions, so they must not appear.
    expect(published.categories).toEqual(['absence']);
    expect(published.run?.categoryCounts).toEqual({ absence: 1 });
  });

  test('counts each question once however many repeats it had', () => {
    const published = publishable(
      HEADER,
      [
        row({ questionId: 'q-001', repeat: 0 }),
        row({ questionId: 'q-001', repeat: 1 }),
        row({ questionId: 'q-002', repeat: 0, category: 'aggregate' }),
      ],
      CATEGORIES,
    );

    expect(published.run?.questions).toBe(2);
    expect(published.run?.categoryCounts).toEqual({ absence: 1, aggregate: 1 });
  });

  test('carries the provenance the page refuses to publish a number without', () => {
    const published = publishable(HEADER, [row({})], CATEGORIES);

    expect(published.schema).toBe(1);
    expect(published.generatedAt).not.toBeNull();
    expect(published.run?.seed).toBe(42);
    expect(published.run?.model).toBe('gpt-5-mini');
    expect(published.run?.provider).toBe('foundry-gpt');
    expect(published.run?.embedder).toBe('text-embedding-3-small');
  });

  /**
   * The published corpus is the page's "measured over what". Rebuilt from the
   * seed at publish time, so check it still matches the fixture the run used.
   */
  test('describes the corpus the seed produces', () => {
    const published = publishable(HEADER, [row({})], CATEGORIES);
    const corpus = corpusShape(HEADER.seed, HEADER.logs);

    expect(published.corpus).toEqual(corpus);
    expect(published.run?.logs).toBe(0);
    expect(corpus.results).toBe(
      corpus.sources.reduce((total, source) => total + source.results, 0),
    );

    const prs = corpus.sources.find((source) => source.tool === 'github.list_pull_requests');
    expect(prs?.paginated).toBe(true);
    expect(prs?.perResult).toBe(25);
    // Verbatim, so parseable and checkable against the generator.
    expect(JSON.parse(prs?.sample as string)).toMatchObject({ ref: expect.any(String) });
  });

  test('gives the log flood its own row when a run opted into one', () => {
    const flooded = corpusShape(HEADER.seed, 500);
    const logs = flooded.sources.find((source) => source.tool === 'logs.search');

    // One result, however many lines — a paginated log would be a kinder tool.
    expect(logs?.paginated).toBe(false);
    expect(logs?.results).toBe(1);
    expect(logs?.records).toBe(500);
  });

  test('leaves evidence metrics null when no question had record-level evidence', () => {
    const published = publishable(
      HEADER,
      [row({ category: 'aggregate', evidenceRecall: null, evidencePrecision: null })],
      CATEGORIES,
    );

    expect(published.adapters[0]?.evidenceRecall).toBeNull();
    expect(published.adapters[0]?.evidencePrecision).toBeNull();
  });
});
