/**
 * `/why`, as markdown. See `./reference-text.ts` for why.
 *
 * "Why would I use this rather than a vector store" is asked of an assistant
 * more often than of a website, so this is generated from the same constants
 * as the page, evidence included.
 */

import { adapterLabel } from '../benchmarks/benchmarks';
import {
  ABSTRACT,
  CONCLUSION,
  evidence,
  HYPOTHESIS,
  INTRODUCTION,
  WHY_DESCRIPTION,
  WHY_TITLE,
} from '../why/why';
import type { Article } from './markdown';
import { blocks, bullets, fence, heading, table } from './markdown';

/** The page, as `llms.txt` lists it and as the file it links to. */
export const WHY: Article = {
  title: 'Why Ingot',
  summary: WHY_DESCRIPTION,
  render: renderWhy,
};

const pct = (value: number): string => `${Math.round(value * 100)}%`;

function renderWhy(): string {
  const found = evidence();

  return `${blocks(
    heading(1, WHY_TITLE),
    `> ${ABSTRACT}`,

    heading(2, `1. Introduction: ${INTRODUCTION.title}`),
    ...INTRODUCTION.before,
    `> ${INTRODUCTION.quote}`,
    ...INTRODUCTION.joins,
    `**${INTRODUCTION.contrast.guess.label} (${INTRODUCTION.contrast.guess.tag.toLowerCase()}).**`,
    bullets(INTRODUCTION.contrast.guess.chunks),
    INTRODUCTION.contrast.guess.note,
    `**${INTRODUCTION.contrast.exact.label} (${INTRODUCTION.contrast.exact.tag.toLowerCase()}).**`,
    fence(INTRODUCTION.contrast.exact.sql),
    INTRODUCTION.contrast.exact.note,
    INTRODUCTION.after,

    heading(2, `2. Hypothesis: ${HYPOTHESIS.title}`),
    HYPOTHESIS.body,
    bullets(HYPOTHESIS.claims.map((claim) => `**${claim.n}.** ${claim.text}`)),
    `**What would prove it wrong:** ${HYPOTHESIS.falsifier}`,

    heading(2, '3. Evidence: What the benchmark shows'),
    found
      ? blocks(
          `${found.method} Run ${found.runDate}.`,
          table(
            ['', found.oursLabel, found.baselineLabel],
            [
              ['Accuracy', pct(found.ours.accuracy), pct(found.baseline.accuracy)],
              [
                'Context tokens per answer',
                found.ours.contextTokens.toLocaleString('en-GB'),
                found.baseline.contextTokens.toLocaleString('en-GB'),
              ],
              ...found.classes.map((bar) => [bar.name, pct(bar.ours), pct(bar.baseline)]),
            ],
          ),
          found.findings,
        )
      : `No run has been published yet with both ${adapterLabel('ingot-rest')} and ${adapterLabel('vector')}.`,

    heading(2, `4. Conclusion: ${CONCLUSION.title}`),
    ...CONCLUSION.body,
    '**Still to show**',
    bullets(CONCLUSION.open),
  )}\n`;
}
