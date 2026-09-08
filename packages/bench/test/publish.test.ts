import { describe, expect, test } from 'bun:test';
import type { Category } from '../src/questions/questions.js';
import { publishable } from '../src/run/publish.js';
import type { ReportHeader, RunRecord } from '../src/run/report.js';

/**
 * The summary the site renders.
 *
 * Worth its own test because it is the one output of this package that another
 * artefact reads: a shape change here renders an empty table on a published
 * page rather than failing anything, and `apps/ingot-app/test/benchmarks.test.tsx`
 * asserts the other end of the same contract.
 */

const HEADER: ReportHeader = {
  runId: 'test-run',
  seed: 42,
  model: 'gpt-5-mini',
  effort: 'high',
  repeats: 2,
  maxToolCalls: 12,
  embedder: 'text-embedding-3-small',
  mapping: 'authored',
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

    // `ordering` and `aggregate` had no questions, so the page must not be
    // handed a column with nothing under it.
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
