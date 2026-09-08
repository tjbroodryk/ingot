import { describe, expect, test } from 'bun:test';
import { flattenRecords } from '../src/corpus/records.js';
import { buildCorpus, corpusRefs } from '../src/corpus/stream.js';
import { buildWorld } from '../src/corpus/world.js';
import { buildQuestions, categoryCounts } from '../src/questions/questions.js';
import { scoreAnswer, scoreRun } from '../src/score/score.js';

const world = buildWorld({ seed: 11 });
const corpus = buildCorpus(world);
const knownRefs = corpusRefs(corpus);
const questions = buildQuestions(world, { perTemplate: 3 });

describe('the question set', () => {
  test('covers every category', () => {
    const counts = categoryCounts(questions);
    for (const category of [
      'aggregate',
      'absence',
      'ordering',
      'join',
      'semantic',
      'multi-hop',
    ]) {
      expect(counts[category] ?? 0).toBeGreaterThan(0);
    }
  });

  test('never asks a question whose gold answer is empty', () => {
    for (const question of questions) {
      if (question.gold.kind === 'number') expect(question.gold.value).toBeGreaterThan(0);
      else expect(question.gold.values.length).toBeGreaterThan(0);
    }
  });

  test('cites only evidence the corpus actually contains', () => {
    for (const question of questions) {
      for (const ref of question.evidence ?? []) {
        // The multi-hop answers name a team rather than a record, but their
        // evidence is still records, so every ref must be reachable.
        expect(knownRefs.has(ref)).toBe(true);
      }
    }
  });

  test('leaves aggregate questions without record-level evidence', () => {
    const aggregates = questions.filter((question) => question.category === 'aggregate');
    expect(aggregates.length).toBeGreaterThan(0);
    for (const question of aggregates) expect(question.evidence).toBeNull();
  });
});

/**
 * The questions whose answer is in no single payload.
 *
 * These are the ones with a way of going quietly wrong that the other
 * categories do not have. A question is generated from the world, where every
 * object holds a reference to every other; it is *answered* from the corpus,
 * which is a lossy view of that world. So a join can be perfectly well defined
 * over the world and unanswerable from what the agent actually received — the
 * incident's `cause` is dropped on the way out, and a join through a field
 * that got dropped the same way would score every adapter at zero and read as
 * a finding about retrieval.
 *
 * Hence: recompute the gold answer from the payloads alone, and check that the
 * link the question turns on is genuinely split across results.
 */
describe('joins across tool results', () => {
  const records = flattenRecords(corpus);
  const items = (tool: string): readonly Record<string, unknown>[] =>
    records.filter((record) => record.tool === tool).map((record) => record.item);

  /** Which team owns each service, per the catalogue payload. */
  const owners = new Map(
    items('catalog.list_services').map((service) => [service.name as string, service.owner]),
  );
  /** Which service each path belongs to, per the file listing payload. */
  const services = new Map(
    items('catalog.list_files').map((file) => [file.path as string, file.service as string]),
  );

  const teamIn = (text: string): string => {
    const found = /owned by the (\w+) team/.exec(text);
    if (!found) throw new Error(`no team named in: ${text}`);
    return found[1] as string;
  };

  test('the two-result join is answerable from the payloads alone', () => {
    const question = questions.find((candidate) =>
      candidate.text.startsWith('Which incidents happened on a service owned by'),
    );
    if (question?.gold.kind !== 'set') throw new Error('no incident/team join');
    const team = teamIn(question.text);

    // The pager result knows which service; only the catalogue knows whose it
    // is. Answering means holding both.
    const answer = items('pagerduty.list_incidents')
      .filter((incident) => owners.get(incident.service as string) === team)
      .map((incident) => incident.ref as string);

    expect(new Set(answer)).toEqual(new Set(question.gold.values));
  });

  test('the three-result join is answerable from the payloads alone', () => {
    const question = questions.find((candidate) =>
      candidate.text.startsWith('Which pull requests are still open and touched a file'),
    );
    if (question?.gold.kind !== 'set') throw new Error('no pr/file/team join');
    const team = teamIn(question.text);

    // Path → file record → service → team: three payloads, and the only thing
    // joining them is a string that happens to appear in both.
    const answer = items('github.list_pull_requests')
      .filter((pr) => pr.state === 'open')
      .filter((pr) =>
        (pr.files as readonly string[]).some(
          (path) => owners.get(services.get(path) ?? '') === team,
        ),
      )
      .map((pr) => pr.ref as string);

    expect(new Set(answer)).toEqual(new Set(question.gold.values));
  });

  /**
   * The property that makes these worth their cost.
   *
   * Similarity is computed per record, and no answer-bearing record here
   * contains the term the question asks with — a pull request has never heard
   * of a team, and an incident names a service and not its owner. A top-k over
   * the question text therefore ranks the answer no higher than anything else,
   * which is exactly the case a memory that can join is supposed to win.
   */
  test('name nothing the answer-bearing records contain', () => {
    const joins = questions.filter((candidate) => /owned by the \w+ team/.test(candidate.text));
    expect(joins.length).toBeGreaterThan(0);

    for (const question of joins) {
      const team = teamIn(question.text);
      const answering = records.filter((record) =>
        (question.evidence ?? []).includes(record.ref),
      );
      expect(answering.length).toBeGreaterThan(0);
      for (const record of answering) expect(record.text).not.toContain(team);
    }
  });

  test('the three-hop argmax lands on a team the catalogue records', () => {
    const question = questions.find((candidate) =>
      candidate.text.startsWith('Which team owns the service whose files have the most total churn'),
    );
    if (question?.gold.kind !== 'set') throw new Error('no churn/team question');

    const churn = new Map<string, number>();
    for (const pr of items('github.list_pull_requests')) {
      for (const path of pr.files as readonly string[]) {
        const service = services.get(path);
        if (service === undefined) continue;
        const change = (pr.additions as number) + (pr.deletions as number);
        churn.set(service, (churn.get(service) ?? 0) + change);
      }
    }
    const [busiest] = [...churn.entries()].sort((a, b) => b[1] - a[1]);

    expect(question.gold.values).toEqual([owners.get(busiest?.[0] as string) as string]);
    // Scored on the answer alone. The cheapest right path is one grouped sum,
    // which returns a team and a total and no record at all — citing evidence
    // here would mark that path as a total retrieval failure, which is the
    // same trap the aggregate questions avoid by carrying no evidence either.
    expect(question.evidence).toBeNull();
  });

  /**
   * The anti-join. Seed 11 has no service without an incident, so this one is
   * asked of a world that does — a question that cannot be generated is not a
   * question that can go untested.
   */
  test('the anti-join names services no incident payload mentions', () => {
    const quietWorld = buildWorld({ seed: 1 });
    const quietRecords = flattenRecords(buildCorpus(quietWorld));
    const question = buildQuestions(quietWorld, { perTemplate: 3 }).find(
      (candidate) => candidate.text === 'Which services have had no incidents at all? Answer with their refs.',
    );
    if (question?.gold.kind !== 'set') throw new Error('no anti-join question');

    const troubled = new Set(
      quietRecords
        .filter((record) => record.tool === 'pagerduty.list_incidents')
        .map((record) => record.item.service as string),
    );
    const answer = quietRecords
      .filter((record) => record.tool === 'catalog.list_services')
      .filter((record) => !troubled.has(record.item.name as string))
      .map((record) => record.ref);

    expect(new Set(answer)).toEqual(new Set(question.gold.values));
    // The point of the category: the emptiness is stated nowhere. No payload
    // says a service had no incidents; it is a fact about two results held
    // together, and there is no text for a nearest-neighbour search to find.
    expect(answer.length).toBeGreaterThan(0);
  });
});

describe('scoring', () => {
  test('counts are exact', () => {
    const question = questions.find((candidate) => candidate.gold.kind === 'number');
    if (question?.gold.kind !== 'number') throw new Error('no counting question');

    expect(scoreAnswer(question, question.gold.value).correct).toBe(true);
    expect(scoreAnswer(question, question.gold.value + 1).correct).toBe(false);
    // A model that answered with a numeral in a string got the retrieval right.
    expect(scoreAnswer(question, String(question.gold.value)).correct).toBe(true);
  });

  test('sets get partial credit but only exact answers are correct', () => {
    const question = questions.find(
      (candidate) => candidate.gold.kind === 'set' && candidate.gold.values.length > 2,
    );
    if (question?.gold.kind !== 'set') throw new Error('no multi-valued set question');

    const gold = question.gold.values;
    expect(scoreAnswer(question, [...gold]).correct).toBe(true);
    // Order must not matter for a set.
    expect(scoreAnswer(question, [...gold].reverse()).correct).toBe(true);

    const partial = scoreAnswer(question, gold.slice(0, gold.length - 1));
    expect(partial.correct).toBe(false);
    expect(partial.f1).toBeGreaterThan(0);
    expect(partial.f1).toBeLessThan(1);
  });

  test('ordered lists must be in the right order', () => {
    const question = questions.find((candidate) => candidate.gold.kind === 'list');
    if (question?.gold.kind !== 'list') throw new Error('no ordering question');

    expect(scoreAnswer(question, [...question.gold.values]).correct).toBe(true);
    expect(scoreAnswer(question, [...question.gold.values].reverse()).correct).toBe(false);
  });

  test('evidence recall reflects what came back through the tools', () => {
    const question = questions.find(
      (candidate) => candidate.evidence !== null && candidate.evidence.length > 1,
    );
    if (!question?.evidence) throw new Error('no question with multi-record evidence');

    const everything = scoreRun(question, [], question.evidence.join(' '), knownRefs);
    expect(everything.evidenceRecall).toBe(1);
    expect(everything.evidencePrecision).toBe(1);

    const half = question.evidence.slice(0, Math.ceil(question.evidence.length / 2));
    const partial = scoreRun(question, [], half.join(' '), knownRefs);
    expect(partial.evidenceRecall).toBeLessThan(1);
    expect(partial.evidenceRecall).toBeGreaterThan(0);

    const nothing = scoreRun(question, [], 'the tools returned prose', knownRefs);
    expect(nothing.evidenceRecall).toBe(0);
  });

  test('a correct answer with no retrieved evidence still scores as correct', () => {
    // The aggregate case: `SELECT count(*)` returns a number and no refs, and
    // scoring it as a retrieval failure would punish the cheapest right answer.
    const question = questions.find((candidate) => candidate.evidence === null);
    if (question?.gold.kind !== 'number') throw new Error('no aggregate question');

    const score = scoreRun(question, question.gold.value, 'count: 37', knownRefs);
    expect(score.correct).toBe(true);
    expect(score.evidenceRecall).toBeNull();
  });
});
