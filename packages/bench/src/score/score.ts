import { refsIn } from '../corpus/records.js';
import type { Ref } from '../corpus/world.js';
import type { Question } from '../questions/questions.js';

/**
 * Scoring, with no model in it. Every category is machine-scorable — counts,
 * sets of refs, ordered lists — so there is no LLM judge in this benchmark.
 */
export interface Score {
  /** The strict verdict: exactly right, no partial credit. */
  readonly correct: boolean;
  /** Partial credit for set answers; 1 or 0 for counts and ordered lists. */
  readonly f1: number;
  /**
   * Fraction of the answer-bearing records whose refs came back through the
   * tools. `null` for statistic answers — see `Question.evidence`.
   */
  readonly evidenceRecall: number | null;
  /** Fraction of the refs the tools returned that were answer-bearing — the noise measure. */
  readonly evidencePrecision: number | null;
}

function normalise(value: unknown): string {
  return String(value).trim().toLowerCase();
}

function toStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === undefined || value === null) return [];
  // A comma-separated string is the envelope wrong, not the retrieval.
  return normalise(value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function setF1(predicted: readonly string[], gold: readonly string[]): number {
  const predictedSet = new Set(predicted);
  const goldSet = new Set(gold);
  if (predictedSet.size === 0 && goldSet.size === 0) return 1;
  if (predictedSet.size === 0 || goldSet.size === 0) return 0;
  let hits = 0;
  for (const value of predictedSet) if (goldSet.has(value)) hits += 1;
  const precision = hits / predictedSet.size;
  const recall = hits / goldSet.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function scoreAnswer(question: Question, answer: unknown): { correct: boolean; f1: number } {
  const gold = question.gold;

  if (gold.kind === 'number') {
    const predicted = typeof answer === 'number' ? answer : Number(normalise(answer));
    const correct = Number.isFinite(predicted) && predicted === gold.value;
    return { correct, f1: correct ? 1 : 0 };
  }

  const predicted = toStrings(answer);
  const expected = gold.values.map(normalise);

  if (gold.kind === 'list') {
    const correct =
      predicted.length === expected.length &&
      predicted.every((value, index) => value === expected[index]);
    return { correct, f1: correct ? 1 : 0 };
  }

  const f1 = setF1(predicted, expected);
  return { correct: f1 === 1, f1 };
}

export function scoreRun(
  question: Question,
  answer: unknown,
  observedText: string,
  knownRefs: ReadonlySet<Ref>,
  /**
   * Whether this adapter reaches its memory through tools. `raw-context` does
   * not — its evidence is in the prompt — so its evidence cell is empty rather
   * than 0%. A retrieval adapter that made no calls still scores zero.
   */
  retrieves = true,
): Score {
  const { correct, f1 } = scoreAnswer(question, answer);

  if (question.evidence === null || !retrieves) {
    return { correct, f1, evidenceRecall: null, evidencePrecision: null };
  }

  const observed = refsIn(observedText, knownRefs);
  const evidence = new Set(question.evidence);
  let hits = 0;
  for (const ref of evidence) if (observed.has(ref)) hits += 1;

  return {
    correct,
    f1,
    evidenceRecall: evidence.size === 0 ? null : hits / evidence.size,
    evidencePrecision: observed.size === 0 ? 0 : hits / observed.size,
  };
}
