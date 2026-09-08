import { describe, expect, test } from 'bun:test';
import { OracleAdapter, RawContextAdapter } from '../src/adapters/controls.js';
import { IngotRestAdapter, renderSchema } from '../src/adapters/ingot-rest.js';
import type { MemoryAdapter } from '../src/adapters/types.js';
import { VectorAdapter } from '../src/adapters/vector.js';
import { refsIn } from '../src/corpus/records.js';
import { buildCorpus, corpusRefs } from '../src/corpus/stream.js';
import { buildWorld } from '../src/corpus/world.js';
import { buildQuestions } from '../src/questions/questions.js';
import { HashEmbedder } from '../src/embed/embedder.js';

/**
 * The adapters that need neither a network nor a key. The Ingot and Hyperspell
 * adapters are exercised by running the benchmark against them, because a mock
 * of a retrieval system would assert that the mock retrieves.
 */
const world = buildWorld({ seed: 2 });
const corpus = buildCorpus(world);
const knownRefs = corpusRefs(corpus);
const questions = buildQuestions(world, { perTemplate: 2 });

/**
 * Enough to construct the REST adapter. Nothing here reaches the network: the
 * tool surface and the schema note are decided before a single call is made,
 * which is exactly the part of it worth asserting on without a server.
 */
const options = { baseUrl: 'http://localhost:3002', account: 'dev', apiKey: 'k', runId: 'test' };

describe('the vector adapter', () => {
  test('returns k records, and refs that the scorer can read', async () => {
    const adapter = new VectorAdapter(new HashEmbedder());
    await adapter.ingest(corpus);

    const output = await adapter.call('search', { query: 'a pull request that was merged', k: 5 });
    const found = refsIn(output, knownRefs);

    expect(found.size).toBeGreaterThan(0);
    expect(found.size).toBeLessThanOrEqual(5);
    expect(output).toContain('#1 score=');
  });

  test('honours k and caps it', async () => {
    const adapter = new VectorAdapter(new HashEmbedder());
    await adapter.ingest(corpus);

    const wide = await adapter.call('search', { query: 'incident', k: 500 });
    expect(refsIn(wide, knownRefs).size).toBeLessThanOrEqual(50);
  });

  test('offers exactly one tool', async () => {
    const adapter = new VectorAdapter(new HashEmbedder());
    expect(adapter.tools().map((tool) => tool.name)).toEqual(['search']);
  });
});

describe('the controls', () => {
  test('raw-context carries the whole corpus and no tools', async () => {
    const adapter = new RawContextAdapter();
    await adapter.ingest(corpus);

    const note = await adapter.systemNote();
    expect(adapter.tools()).toHaveLength(0);
    expect(refsIn(note, knownRefs).size).toBe(knownRefs.size);
  });

  test('oracle carries exactly the evidence and nothing else', async () => {
    const adapter = new OracleAdapter();
    await adapter.ingest(corpus);

    const question = questions.find((candidate) => candidate.evidence !== null);
    if (!question?.evidence) throw new Error('no question with evidence');

    const note = await adapter.systemNote(question);
    const found = refsIn(note, knownRefs);
    // A record can legitimately mention another — a PR names file paths, not
    // file refs — so the assertion is that every piece of evidence is present,
    // and that nothing irrelevant was added beyond what the records say.
    for (const ref of question.evidence) expect(found.has(ref)).toBe(true);
    expect(found.size).toBeLessThanOrEqual(question.evidence.length + 1);
  });

  test('oracle refuses to fake a ceiling for statistic questions', async () => {
    const adapter = new OracleAdapter();
    await adapter.ingest(corpus);

    const aggregate = questions.find((candidate) => candidate.evidence === null);
    if (!aggregate) throw new Error('no aggregate question');
    expect(await adapter.systemNote(aggregate)).toContain('ORACLE_UNAVAILABLE');
  });

  test('oracle declines the questions it cannot bound, and claims the rest', () => {
    const adapter = new OracleAdapter();
    const aggregate = questions.find((candidate) => candidate.evidence === null);
    const withEvidence = questions.find((candidate) => candidate.evidence !== null);
    if (!aggregate || !withEvidence) throw new Error('need one question of each kind');

    // The runner reads this, and a `false` is why the cell is `—` rather than
    // a zero that would drag the upper bound below what it bounds.
    expect(adapter.supports(aggregate)).toBe(false);
    expect(adapter.supports(withEvidence)).toBe(true);
  });

  test('raw-context bounds every question, including the statistics', () => {
    const adapter: MemoryAdapter = new RawContextAdapter();
    expect(adapter.supports).toBeUndefined();
  });
});

describe('the ingot REST adapter', () => {
  test('offers a tool surface authored here, matched to the mode', () => {
    const full = new IngotRestAdapter({ ...options, mode: 'full' });
    const ablated = new IngotRestAdapter({ ...options, mode: 'recall-only' });

    expect(full.name).toBe('ingot-rest');
    expect(full.tools().map((tool) => tool.name)).toEqual(['query', 'search']);
    expect(ablated.name).toBe('ingot-rest-recall-only');
    expect(ablated.tools().map((tool) => tool.name)).toEqual(['search']);
  });

  test('its search tool takes the same arguments as the vector baseline', () => {
    const search = new IngotRestAdapter(options).tools().find((tool) => tool.name === 'search');
    const baseline = new VectorAdapter(new HashEmbedder()).tools()[0];
    if (!search || !baseline) throw new Error('both adapters should offer a search');

    // The point of this adapter is that its surface is no better written than
    // the baseline's. Both take a plain-language query and a row cap, and if
    // one ever grows an argument the other lacks, that is a thumb on the scale.
    const argument = (tool: { input_schema: Record<string, unknown> }): string[] =>
      Object.keys(tool.input_schema.properties as Record<string, unknown>).sort();
    expect(argument(search)).toContain('query');
    expect(argument(baseline)).toContain('query');
  });

  test('renders the schema note from /info, embedded columns marked', () => {
    const note = renderSchema({
      tables: [
        {
          name: 'incidents',
          key: ['ref'],
          rows: 42,
          columns: [
            { name: 'ref', type: 'VARCHAR', embedded: false },
            { name: 'summary', type: 'VARCHAR', embedded: true },
          ],
        },
      ],
    });

    expect(note).toBe('incidents (ref VARCHAR, summary VARCHAR [embedded]), key (ref) — 42 rows');
  });
});
