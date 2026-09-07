/**
 * The deployment page, as markdown. See `./reference-text.ts` for why.
 *
 * This one has more to lose from being written twice than the reference does.
 * Every variable name and default on the page is read off the repository, and
 * a plain-text copy that fell behind would be a list of environment variables
 * that does not match the service — which is the one kind of documentation
 * that costs a reader an outage rather than a minute.
 */

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
  // What the tab says, rather than the headline — this is the entry in an
  // index, and an index is read by scanning the left edge of it.
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
          // The page marks a variable with nothing to fall back to rather than
          // leaving the cell blank, because that is the interesting case: it
          // is the difference between a service that starts with a default you
          // did not choose and one that refuses to start at all.
          setting.fallback ?? '**none — refuses to boot**',
          setting.note,
        ]),
      ),
  );
}
