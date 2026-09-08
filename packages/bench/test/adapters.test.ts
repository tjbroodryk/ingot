import { describe, expect, test } from 'bun:test';
import { RawContextAdapter } from '../src/adapters/controls.js';
import { HyperspellAdapter } from '../src/adapters/hyperspell.js';
import { IngotRestAdapter, renderSchema } from '../src/adapters/ingot-rest.js';
import { PineconeAdapter } from '../src/adapters/pinecone.js';
import { clampK, MAX_K, renderHits } from '../src/adapters/semantic-search.js';
import { TurbopufferAdapter } from '../src/adapters/turbopuffer.js';
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

/**
 * The top-k rows — one local, two hosted vector databases, one hosted memory —
 * have to reach the model through exactly the same words.
 *
 * This is the test that keeps `pinecone` and `turbopuffer` from turning into a
 * comparison of prompt copy. Each was added by writing an adapter that ranks
 * the same vectors somewhere else; if adding one had also meant writing it a
 * slightly better tool description, the accuracy column would have carried
 * that difference and reported it as retrieval.
 *
 * None of these constructors touches the network — where the vectors live is
 * decided at ingest, and the surface is decided before that.
 */
describe('the top-k baselines', () => {
  const baselines: readonly MemoryAdapter[] = [
    new VectorAdapter(new HashEmbedder()),
    new PineconeAdapter(
      { apiKey: 'k', index: 'ingot-bench', cloud: 'aws', region: 'us-east-1', runId: 'test' },
      new HashEmbedder(),
    ),
    new TurbopufferAdapter(
      { apiKey: 'k', region: 'aws-us-east-1', runId: 'test' },
      new HashEmbedder(),
    ),
    new HyperspellAdapter({ apiKey: 'k', runId: 'test' }),
  ];

  test('are one row each, named for the store they rank in', () => {
    expect(baselines.map((adapter) => adapter.name)).toEqual([
      'vector',
      'pinecone',
      'turbopuffer',
      'hyperspell',
    ]);
  });

  test('offer the identical search tool, down to the description', () => {
    const [first] = baselines;
    if (!first) throw new Error('no baselines');
    for (const adapter of baselines) {
      expect(adapter.tools()).toEqual(first.tools());
      expect(adapter.tools()).toHaveLength(1);
    }
  });

  test('contribute the identical system note', async () => {
    const question = questions[0];
    if (!question) throw new Error('no questions');
    const notes = await Promise.all(baselines.map((adapter) => adapter.systemNote(question)));
    expect(new Set(notes).size).toBe(1);
  });

  test('answer every question, having no ceiling to decline', () => {
    for (const adapter of baselines) expect(adapter.supports).toBeUndefined();
  });
});

describe('the shared search surface', () => {
  test('defaults k to 10 and caps it, whatever the model asks for', () => {
    expect(clampK(undefined)).toBe(10);
    expect(clampK('not a number')).toBe(10);
    expect(clampK(0)).toBe(10);
    expect(clampK(5)).toBe(5);
    expect(clampK(500)).toBe(MAX_K);
  });

  test('prints a score only when the store returned one', () => {
    expect(renderHits([{ score: 0.5, text: 'a' }])).toBe('#1 score=0.5000\na');
    // A store with no comparable score gets no score, rather than a zero the
    // model would read as "nothing matched".
    expect(renderHits([{ score: null, text: 'a' }])).toBe('#1\na');
  });

  test('says so when nothing came back', () => {
    expect(renderHits([])).toBe('No records.');
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

  test('raw-context bounds every question, including the statistics', () => {
    const adapter: MemoryAdapter = new RawContextAdapter();
    expect(adapter.supports).toBeUndefined();
  });
});

describe('the ingot REST adapter', () => {
  test('offers a tool surface authored here, matched to the mode', () => {
    const full = new IngotRestAdapter({ ...options, mode: 'full' });
    const ablated = new IngotRestAdapter({ ...options, mode: 'text-search-only' });

    expect(full.name).toBe('ingot-rest');
    expect(full.tools().map((tool) => tool.name)).toEqual(['query', 'search']);
    expect(ablated.name).toBe('control-same-store-top-k-rest');
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
