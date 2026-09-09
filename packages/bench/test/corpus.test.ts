import { describe, expect, test } from 'bun:test';
import { flattenRecords, refsIn } from '../src/corpus/records.js';
import { buildCorpus, corpusRefs } from '../src/corpus/stream.js';
import { buildWorld } from '../src/corpus/world.js';

describe('the corpus', () => {
  test('is identical for a seed and different for another', () => {
    const first = buildCorpus(buildWorld({ seed: 7 }));
    const again = buildCorpus(buildWorld({ seed: 7 }));
    const other = buildCorpus(buildWorld({ seed: 8 }));

    expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));
  });

  test('carries every world record exactly once', () => {
    const world = buildWorld({ seed: 3 });
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

/**
 * The drifted corpus, and the two rules that keep it a harder benchmark rather
 * than a broken one.
 *
 * `--drift` exists to attack the mechanism this project is built on: `remember`
 * commits to a column mapping before it has seen the last page, and a vector
 * store commits to nothing. A benchmark that only ever ran over one shape per
 * tool would be measuring SQL against top-k on a corpus that was already a
 * table. So the tests below are not about the drifts themselves — those are
 * meant to hurt — but about the line between hard and unanswerable, which is
 * the only thing that makes a bad result publishable.
 */
describe('the drifted corpus', () => {
  const world = buildWorld({ seed: 4 });
  const plain = buildCorpus(world);
  const drifted = buildCorpus(world, { drift: true });

  test('is deterministic, and is not the ordinary corpus', () => {
    expect(JSON.stringify(drifted)).toBe(JSON.stringify(buildCorpus(world, { drift: true })));
    expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(plain));
  });

  test('is off unless it is asked for', () => {
    expect(JSON.stringify(buildCorpus(world, {}))).toBe(JSON.stringify(plain));
  });

  /**
   * The first rule. Drift changes how the world is written down and never what
   * is in it, so every gold answer stays reachable and evidence recall stays
   * scoreable — a drift that dropped records would be marking adapters against
   * evidence the corpus does not contain, which is a rigged loss rather than a
   * hard one.
   */
  test('loses no record and no ref', () => {
    expect([...corpusRefs(drifted)].sort()).toEqual([...corpusRefs(plain)].sort());
    expect(flattenRecords(drifted)).toHaveLength(flattenRecords(plain).length);
  });

  /**
   * The second rule. Every drift has to be visible on both sides of the change
   * — enough records in each shape that anything which looks will find both.
   * A drift that fired on three records out of two hundred would be testing
   * whether an adapter can spot a rarity, which is a different question.
   */
  test('shows both shapes of every field it drifts', () => {
    const has = (tool: string, key: string): number =>
      flattenRecords(drifted).filter((record) => record.tool === tool && key in record.item).length;

    for (const [tool, before, after] of [
      ['catalog.list_services', 'owner', 'owner_team'],
      ['ci.list_runs', 'duration_sec', 'duration_ms'],
      ['catalog.list_files', 'loc', 'service_ref'],
    ] as const) {
      expect(has(tool, before)).toBeGreaterThan(0);
      expect(has(tool, after)).toBeGreaterThan(0);
    }

    const assignees = flattenRecords(drifted)
      .filter((record) => record.tool === 'linear.search_issues')
      .map((record) => record.item.assignee);
    expect(assignees.some((value) => typeof value === 'string')).toBe(true);
    expect(assignees.some((value) => typeof value === 'object' && value !== null)).toBe(true);
    // Null is the fact the `absence` category asks about, and it has to survive
    // the type change unchanged or that category would be measuring the drift
    // rather than absence.
    expect(assignees.some((value) => value === null)).toBe(true);
  });

  /**
   * The renamed unit carries the converted value. A rename that left the number
   * alone would be a corpus stating something false about the world, and the
   * gold answers are computed from the world — the question has to stay
   * answerable by an adapter that notices, which means the milliseconds have to
   * be real milliseconds.
   */
  test('changes the value when it changes the unit', () => {
    const seconds = new Map(world.ciRuns.map((run) => [run.ref, run.durationSec]));
    for (const record of flattenRecords(drifted)) {
      if (record.tool !== 'ci.list_runs') continue;
      const truth = seconds.get(record.ref) as number;
      if ('duration_ms' in record.item) expect(record.item.duration_ms).toBe(truth * 1000);
      else expect(record.item.duration_sec).toBe(truth);
    }
  });

  /**
   * Every payload stays a payload the baselines can see.
   *
   * This is the rule that retired the fifth drift. A rate-limit body with no
   * `items` is invisible to `flattenRecords`, which every vector column
   * chunks with, and fatal to Ingot's `/add`, which rejects it and takes the
   * column with it. Drift has to change what a record looks like, never
   * whether an adapter can ingest the corpus at all — so the drifted corpus
   * has the same payloads as the plain one, and every one of them still holds
   * records.
   */
  test('adds no payload the baselines cannot chunk', () => {
    expect(drifted).toHaveLength(plain.length);
    for (const result of drifted) {
      const page = result.result as { items?: readonly unknown[] };
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items?.length).toBeGreaterThan(0);
    }
  });

  /** The paraphrase invariant is not something drift is allowed to break. */
  test('still never contains the paraphrase a semantic question asks with', () => {
    const text = JSON.stringify(drifted).toLowerCase();
    for (const incident of world.incidents) {
      expect(text).not.toContain(incident.cause.paraphrase.toLowerCase());
    }
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
