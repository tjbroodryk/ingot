/**
 * The reference, as markdown.
 *
 * The same content module `src/docs/reference-page.tsx` renders, walked in the
 * same order and emitted as text — so a route added to `reference.ts` appears
 * in both artefacts or in neither. That is the whole reason this is a second
 * renderer over shared data rather than a second document: a hand-written
 * `docs.md` would be a reference that drifts, and a reference that drifts is
 * worse than none because it is believed.
 *
 * Who reads it: a model, or anything else that would rather not parse the
 * page. The HTML carries a sidebar, a header and an accent face; none of that
 * is the contract, and all of it is noise in a context window.
 */

import {
  BASICS,
  QUICKSTART,
  REFERENCE_DESCRIPTION,
  REFERENCE_LEDE,
  REFERENCE_TITLE,
  STATUS_CODES,
} from '../docs/page-sections';
import {
  Auth,
  type Endpoint,
  ENDPOINTS,
  GROUPS,
  GROUP_ORDER,
  endpointsIn,
} from '../docs/reference';
import type { Article } from './markdown';
import { blocks, bullets, fence, heading, table } from './markdown';

/** The reference, as `llms.txt` lists it and as the file it links to. */
export const REFERENCE: Article = {
  title: REFERENCE_TITLE,
  summary: `${REFERENCE_DESCRIPTION} ${ENDPOINTS.length} routes, one bearer key.`,
  render: renderReference,
};

function renderReference(): string {
  return `${blocks(
    heading(1, REFERENCE_TITLE),
    `> ${REFERENCE_DESCRIPTION}`,
    REFERENCE_LEDE,

    ...BASICS.map((basic) =>
      blocks(heading(2, `${basic.kicker} — ${basic.title}`), basic.body, fence(basic.sample)),
    ),

    blocks(heading(2, 'Quickstart'), fence(QUICKSTART)),

    blocks(
      heading(2, 'Status codes'),
      table(
        ['Code', 'When'],
        STATUS_CODES.map((status) => [status.code, status.when]),
      ),
    ),

    heading(2, 'Endpoints'),

    ...GROUP_ORDER.map((group) =>
      blocks(heading(3, GROUPS[group].title), ...endpointsIn(group).map(renderEndpoint)),
    ),
  )}\n`;
}

/**
 * One route.
 *
 * The heading is the method and the path together, because that pair is how
 * every other document about an HTTP service refers to a route and is what a
 * reader searching this file will type. `auth` is a line of its own rather
 * than a badge: three routes are open and the whole point of saying so is that
 * it is checkable.
 */
function renderEndpoint(endpoint: Endpoint): string {
  return blocks(
    heading(4, `${endpoint.method} ${endpoint.path}`),
    `Auth: ${endpoint.auth === Auth.Key ? 'bearer key' : 'open'}`,
    endpoint.summary,
    endpoint.note,
    endpoint.chips && bullets(endpoint.chips),
    endpoint.fields &&
      table(
        ['Field', 'What it is'],
        endpoint.fields.map((field) => [field.name, field.doc]),
      ),
    endpoint.sample && fence(endpoint.sample),
    // The tool list of an MCP route, which the page sets in the column the
    // sample would have taken. Nothing in a text file has two columns, so it
    // is a list under the prose like any other.
    endpoint.asideChips && bullets(endpoint.asideChips),
  );
}
