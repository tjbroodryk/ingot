import { describe, expect, test } from 'bun:test';
import type { Category } from '../src/questions/questions.js';
import {
  corpusShape,
  labelFor,
  NO_RESULTS,
  NO_TRANSCRIPTS,
  publishable,
  transcriptsPathFor,
  transcriptTable,
  withTable,
  withTranscripts,
} from '../src/run/publish.js';
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
  perTemplate: 3,
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

    expect(published.run?.seed).toBe(42);
    expect(published.run?.model).toBe('gpt-5-mini');
    expect(published.run?.provider).toBe('foundry-gpt');
    expect(published.run?.embedder).toBe('text-embedding-3-small');
  });

  /**
   * The published corpus is the page's answer to "measured over what", and it
   * has to be the corpus the adapters were actually handed rather than a
   * description of one. It is rebuilt from the seed at publish time, so the
   * assertion worth having is that it still matches the fixture the run used.
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
    // Verbatim, and therefore parseable: a sample that had been trimmed to
    // fit a card would be a sample nobody could check against the generator.
    expect(JSON.parse(prs?.sample as string)).toMatchObject({ ref: expect.any(String) });
  });

  test('gives the log flood its own row when a run opted into one', () => {
    const flooded = corpusShape(HEADER.seed, 500);
    const logs = flooded.sources.find((source) => source.tool === 'logs.search');

    // The whole point of `--logs`: one result, however many lines. A corpus
    // that paginated it would be modelling a kinder tool than the one that
    // causes the problem, and the page would draw it as an ordinary listing.
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

/**
 * The file the page reads holds one table per corpus, and a publish adds to it.
 *
 * The failure this exists to prevent is quiet: the ordinary run is bought,
 * published, and eighty minutes later the drifted one is published over the
 * top of it. Both are expensive, only one is on the page, and the only symptom
 * is a tab that used to be there.
 */
describe('publishing into a file that already has a run in it', () => {
  const table = (over: Partial<ReportHeader>) =>
    publishable({ ...HEADER, ...over }, [row({})], CATEGORIES);

  test('keeps the run already there and adds the new one', () => {
    const one = withTable(NO_RESULTS, table({ runId: 'plain' }));
    const two = withTable(one, table({ runId: 'drifted', drift: true }));

    expect(two.tables.map((t) => t.label)).toEqual(['ordinary corpus', 'drifted']);
    expect(two.tables.map((t) => t.run.runId)).toEqual(['plain', 'drifted']);
  });

  test('puts the ordinary corpus first however the runs arrived', () => {
    const one = withTable(NO_RESULTS, table({ runId: 'drifted', drift: true }));
    const two = withTable(one, table({ runId: 'plain' }));

    // The tab that opens is the case the rest of the page's prose describes.
    expect(two.tables[0]?.label).toBe('ordinary corpus');
  });

  test('replaces a re-publish of the same experiment rather than doubling it', () => {
    const one = withTable(NO_RESULTS, table({ runId: 'first' }));
    const again = withTable(one, table({ runId: 'second' }));

    expect(again.tables).toHaveLength(1);
    expect(again.tables[0]?.run.runId).toBe('second');
  });

  /**
   * Labels are a pure function of the settings that make a run a different
   * experiment, which is what makes "same label" and "same experiment" the
   * same test. A label written by hand could collide between two runs a reader
   * genuinely needs to tell apart.
   */
  test('names a run by what makes it a different experiment', () => {
    expect(labelFor(table({}).run).label).toBe('ordinary corpus');
    expect(labelFor(table({ drift: true }).run).label).toBe('drifted');
    expect(labelFor(table({ logs: 5000 }).run).label).toBe('5,000 log lines');
    expect(labelFor(table({ mapping: 'agent' }).run).label).toBe('agent-mapped');
    expect(labelFor(table({ drift: true, mapping: 'agent' }).run).label).toBe(
      'drifted, agent-mapped',
    );
  });

  test('starts empty and says so', () => {
    expect(NO_RESULTS.tables).toEqual([]);
    expect(NO_RESULTS.schema).toBe(2);
    expect(NO_RESULTS.generatedAt).toBeNull();
  });
});

/**
 * The transcripts, which are the summary's evidence and the reason this whole
 * change exists: a mean asks to be trusted, a transcript can be checked. They
 * are published separately from the summary — tens of megabytes of returned
 * rows have no business in the page's bundle — so the failures worth catching
 * are that the wrong repeat is kept, that an output is published uncapped or a
 * cap is left unmarked, and that a second publish orphans the first's rows.
 */
describe('transcriptTable', () => {
  const call = (over: Partial<RunRecord['calls'][number]>): RunRecord['calls'][number] => ({
    name: 'query',
    input: { sql: 'SELECT count(*) FROM prs' },
    output: '36',
    ms: 12,
    failed: false,
    ...over,
  });

  test('publishes one repeat per (adapter, question), the lowest-numbered', () => {
    // Three near-identical transcripts triple the file and tell a reader nothing
    // the first does not — and at concurrency > 1 the rows do not arrive in
    // repeat order, so "the first row seen" is the wrong one to keep.
    const table = transcriptTable('ordinary corpus', [
      row({ adapter: 'ingot', questionId: 'q-002', repeat: 2, answer: 'from repeat 2' }),
      row({ adapter: 'ingot', questionId: 'q-002', repeat: 0, answer: 'from repeat 0' }),
      row({ adapter: 'ingot', questionId: 'q-002', repeat: 1, answer: 'from repeat 1' }),
    ]);

    expect(table.questions).toHaveLength(1);
    const [only] = table.questions[0]?.adapters ?? [];
    expect(only?.answer).toBe('from repeat 0');
  });

  test('keeps inputs verbatim and caps outputs with the truncation marked', () => {
    const long = 'x'.repeat(700);
    const table = transcriptTable('ordinary corpus', [
      row({
        adapter: 'ingot',
        questionId: 'q-001',
        calls: [call({ input: { sql: 'SELECT * FROM files' }, output: long })],
      }),
    ]);

    const [published] = table.questions[0]?.adapters[0]?.calls ?? [];
    // The interesting half, whole: the SQL is what a reader came to check.
    expect(published?.input).toEqual({ sql: 'SELECT * FROM files' });
    // The expensive half, capped — and said out loud, so nobody reads a clip
    // as a tool that genuinely returned this little.
    expect(published?.output).toBe(`${'x'.repeat(600)}… 100 more characters`);
  });

  test('says "character" in the singular when exactly one was dropped', () => {
    const table = transcriptTable('ordinary corpus', [
      row({ calls: [call({ output: 'y'.repeat(601) })] }),
    ]);
    expect(table.questions[0]?.adapters[0]?.calls[0]?.output).toBe(`${'y'.repeat(600)}… 1 more character`);
  });

  test('leaves a short output exactly as it was', () => {
    const table = transcriptTable('ordinary corpus', [row({ calls: [call({ output: '36' })] })]);
    expect(table.questions[0]?.adapters[0]?.calls[0]?.output).toBe('36');
  });

  test('orders questions by id and columns as the run met them', () => {
    const table = transcriptTable('ordinary corpus', [
      row({ adapter: 'vector', questionId: 'q-002' }),
      row({ adapter: 'ingot', questionId: 'q-002' }),
      row({ adapter: 'ingot', questionId: 'q-001' }),
      row({ adapter: 'vector', questionId: 'q-001' }),
    ]);

    expect(table.questions.map((q) => q.id)).toEqual(['q-001', 'q-002']);
    // Column order is first-appearance order — the order the table shows them —
    // not alphabetical and not per-question completion order.
    expect(table.questions[0]?.adapters.map((a) => a.adapter)).toEqual(['vector', 'ingot']);
    expect(table.questions[1]?.adapters.map((a) => a.adapter)).toEqual(['vector', 'ingot']);
  });

  test('carries the gold and the answer each column gave, so the row can be checked', () => {
    const table = transcriptTable('ordinary corpus', [
      row({
        adapter: 'ingot',
        questionId: 'q-001',
        gold: { kind: 'number', value: 36 },
        answer: 0,
        correct: false,
      }),
    ]);

    const question = table.questions[0];
    expect(question?.gold).toEqual({ kind: 'number', value: 36 });
    expect(question?.adapters[0]?.answer).toBe(0);
    expect(question?.adapters[0]?.correct).toBe(false);
  });
});

/**
 * The merge that keeps a re-publish from orphaning transcripts.
 *
 * This is the failure that would actually bite: the summary merges per table,
 * so if the sidecar did not, publishing the drifted run an hour after the
 * ordinary one would drop the ordinary run's transcripts while the summary went
 * on linking to them. The mirror of the summary's own `withTable` test.
 */
describe('withTranscripts', () => {
  const table = (label: string, answer: unknown) => ({
    label,
    questions: [
      {
        id: 'q-001',
        question: 'how many?',
        category: 'aggregate' as Category,
        gold: { kind: 'number', value: 1 } as const,
        adapters: [{ adapter: 'ingot', answer, correct: true, calls: [] }],
      },
    ],
  });

  test('adds a new corpus and keeps the ones already there', () => {
    const one = withTranscripts(NO_TRANSCRIPTS, table('ordinary corpus', 1));
    const two = withTranscripts(one, table('drifted', 2));

    expect(two.tables.map((t) => t.label)).toEqual(['ordinary corpus', 'drifted']);
  });

  test('replaces a re-publish of the same corpus rather than doubling it', () => {
    const one = withTranscripts(NO_TRANSCRIPTS, table('ordinary corpus', 1));
    const again = withTranscripts(one, table('ordinary corpus', 2));

    expect(again.tables).toHaveLength(1);
    expect(again.tables[0]?.questions[0]?.adapters[0]?.answer).toBe(2);
  });

  test('starts empty and says so', () => {
    expect(NO_TRANSCRIPTS.tables).toEqual([]);
    expect(NO_TRANSCRIPTS.schema).toBe(1);
    expect(NO_TRANSCRIPTS.generatedAt).toBeNull();
  });
});

/**
 * The sidecar's path is derived from the summary's, never given its own flag,
 * so the two files cannot be pointed at different runs. The page fetches it out
 * of `public/`, which a static export serves and `src/` it does not.
 */
test('puts the transcript sidecar in the app’s public directory', () => {
  expect(transcriptsPathFor('apps/ingot-app/src/benchmarks/results.json')).toBe(
    'apps/ingot-app/public/benchmark-transcripts.json',
  );
});
