import { describe, expect, test } from 'bun:test';
import { flattenRecords, refsIn } from '../src/corpus/records.js';
import { buildCorpus, corpusRefs } from '../src/corpus/stream.js';
import { buildWorld, RECENT_SINCE, type World } from '../src/corpus/world.js';

describe('the corpus', () => {
  test('is identical for a seed and different for another', () => {
    const first = buildCorpus(buildWorld({ seed: 7 }));
    const again = buildCorpus(buildWorld({ seed: 7 }));
    const other = buildCorpus(buildWorld({ seed: 8 }));

    expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));
  });

  test('at 1× is the ordinary corpus, byte for byte', () => {
    const plain = buildCorpus(buildWorld({ seed: 1 }));
    const scaled = buildCorpus(buildWorld({ seed: 1, scale: 1 }));
    expect(JSON.stringify(scaled)).toBe(JSON.stringify(plain));
  });

  /**
   * What makes a `--scale` series one experiment rather than several: the
   * recent 90 days are the same records at every scale, and everything added
   * is older than the window the questions ask about.
   */
  test('grows only with history older than the recent window', () => {
    const small = buildWorld({ seed: 1, scale: 1 });
    const large = buildWorld({ seed: 1, scale: 4 });
    const since = Date.parse(RECENT_SINCE);
    const recentOf = (world: World) => ({
      pullRequests: world.pullRequests.filter((pr) => Date.parse(pr.createdAt) >= since),
      issues: world.issues.filter((issue) => Date.parse(issue.createdAt) >= since),
    });

    expect(large.pullRequests).toHaveLength(small.pullRequests.length * 4);
    expect(large.issues).toHaveLength(small.issues.length * 4);
    expect(recentOf(large)).toEqual(recentOf(small));
    expect(recentOf(small).pullRequests).toEqual([...small.pullRequests]);
    expect(large.incidents).toEqual(small.incidents);
  });

  test('carries every world record exactly once, at any scale', () => {
    const world = buildWorld({ seed: 3, scale: 3 });
    const corpus = buildCorpus(world);
    const refs = corpusRefs(corpus);

    const expected =
      world.services.length +
      world.files.length +
      world.pullRequests.length +
      world.ciRuns.length +
      world.incidents.length +
      world.issues.length;

    expect(refs.size).toBe(expected);
    expect(flattenRecords(corpus)).toHaveLength(expected);
  });

  /**
   * The invariant the semantic category rests on. If a paraphrase leaked into
   * the corpus, keyword search would answer those questions and the category
   * would stop measuring meaning — which is exactly the failure that would
   * flatter the wrong side of the comparison.
   */
  test('never contains the paraphrase a semantic question asks with', () => {
    const world = buildWorld({ seed: 5 });
    const text = JSON.stringify(buildCorpus(world)).toLowerCase();

    for (const incident of world.incidents) {
      expect(text).not.toContain(incident.cause.paraphrase.toLowerCase());
    }
  });

  test('states an absent owner rather than omitting the key', () => {
    const world = buildWorld({ seed: 5 });
    const services = flattenRecords(buildCorpus(world)).filter((record) =>
      record.ref.startsWith('svc:'),
    );

    expect(services.length).toBeGreaterThan(0);
    for (const service of services) expect('owner' in service.item).toBe(true);
    expect(services.some((service) => service.item.owner === null)).toBe(true);
  });
});

describe('refsIn', () => {
  const known = new Set(['pr:1401', 'inc:INC-02', 'svc:billing']);

  test('finds known refs and ignores everything else', () => {
    const found = refsIn('rows: pr:1401, inc:INC-02, pr:9999, and some prose', known);
    expect([...found].sort()).toEqual(['inc:INC-02', 'pr:1401']);
  });

  test('finds nothing in text that has no refs', () => {
    expect(refsIn('there were thirty-seven of them', known).size).toBe(0);
  });
});
