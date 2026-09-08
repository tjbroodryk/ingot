import { describe, expect, test } from 'bun:test';
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
