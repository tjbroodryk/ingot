/** The deployment page, as markdown. Rendered from the same data as the HTML page. */

import {
  BRING_IT_UP_LEDE,
  type Dependency,
  DEPLOYMENT_DESCRIPTION,
  DEPLOYMENT_LEDE,
  DEPLOYMENT_TITLE,
  NOT_NEEDED,
  OPTIONAL,
  REQUIRED,
  SUMMARY,
} from '../deployment/dependencies';
import { ELSEWHERE, type RunTarget, RUN_TARGETS } from '../deployment/targets';
import type { Article } from './markdown';
import { blocks, bullets, fence, heading, table } from './markdown';

/** The deployment page, as `llms.txt` lists it and as the file it links to. */
export const DEPLOYMENT: Article = {
  // The tab's word, not the headline: this is an index entry.
  title: 'Deployment',
  summary: DEPLOYMENT_DESCRIPTION,
  render: renderDeployment,
};

function renderDeployment(): string {
  return `${blocks(
    heading(1, DEPLOYMENT_TITLE),
    `> ${DEPLOYMENT_DESCRIPTION}`,
    DEPLOYMENT_LEDE,

    ...SUMMARY.map((cell) =>
      blocks(heading(2, `${cell.kicker} — ${cell.title}`), cell.body, fence(cell.sample)),
    ),

    blocks(heading(2, 'Bring it up'), BRING_IT_UP_LEDE),
    ...RUN_TARGETS.map(renderTarget),
    blocks(heading(3, ELSEWHERE.title), ELSEWHERE.body),

    ...[...REQUIRED, ...OPTIONAL].map(renderDependency),

    blocks(
      heading(2, 'What you do not run'),
      table(
        ['Not a dependency', 'What stands in for it'],
        NOT_NEEDED.map((absence) => [absence.title, absence.body]),
      ),
    ),
  )}\n`;
}

/** One way of running it, answering the same four questions in the same order. */
function renderTarget(target: RunTarget): string {
  return blocks(
    heading(3, `${target.title} — ${target.kicker}`),
    target.summary,
    'Needs:',
    bullets(target.needs),
    'Run:',
    fence(target.run),
    'Check:',
    fence(target.check),
    `What catches people: ${target.catches}`,
    `More: ${target.more.label} — ${target.more.href}`,
  );
}

/** The argument, then the sample, then the variables — as the page has it. */
function renderDependency(dependency: Dependency): string {
  return blocks(
    heading(2, `${dependency.title} — ${dependency.kicker}`),
    ...dependency.body,
    dependency.sample && fence(dependency.sample),
    dependency.settings &&
      table(
        ['Variable', 'Default', 'Note'],
        dependency.settings.map((setting) => [
          `\`${setting.name}\``,
          // No fallback is marked, not left blank: it is what makes the service refuse to boot.
          setting.fallback ?? '**none — refuses to boot**',
          setting.note,
        ]),
      ),
  );
}
