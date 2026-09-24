/** The reference, as markdown: the same data `reference-page.tsx` renders, emitted as text. */

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

/** One route, headed by its method and path. */
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
    // An MCP route's tool list, as a plain list here rather than the page's second column.
    endpoint.asideChips && bullets(endpoint.asideChips),
  );
}
