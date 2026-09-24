/**
 * `/features`, as markdown. See `./reference-text.ts` for why.
 */

import { COMBINED, FEATURES, FEATURES_DESCRIPTION, FEATURES_LEDE } from '../features/features';
import type { Article } from './markdown';
import { blocks, bullets, heading, wire } from './markdown';

export const FEATURES_ARTICLE: Article = {
  title: 'Features',
  summary: FEATURES_DESCRIPTION,
  render: renderFeatures,
};

function renderFeatures(): string {
  return `${blocks(
    heading(1, 'Features'),
    FEATURES_LEDE,
    bullets(FEATURES.map((feature) => `**${feature.name}.** ${feature.summary}`)),
    ...FEATURES.map((feature) =>
      blocks(
        heading(2, `${feature.name}: ${feature.title}`),
        feature.lede,
        wire(
          `POST ${feature.path}\n${feature.request}\n\n# ${feature.status}\n${feature.response}`,
        ),
        '**Reach for it when**',
        bullets(feature.when),
        `**Not the right tool when:** ${feature.not}`,
      ),
    ),
    heading(2, `${COMBINED.name}: ${COMBINED.title}`),
    COMBINED.lede,
    wire(
      `POST ${COMBINED.path}\n${COMBINED.request}\n\n# ${COMBINED.status}\n${COMBINED.response}`,
    ),
    bullets(COMBINED.steps.map((step) => `**${step.label}.** ${step.text}`)),
  )}\n`;
}
