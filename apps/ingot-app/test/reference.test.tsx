import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EndpointRow } from '../src/docs/endpoint-row';
import { DocsNav } from '../src/docs/docs-nav';
import { BASICS } from '../src/docs/page-sections';
import {
  Auth,
  ENDPOINTS,
  type EndpointGroup,
  GROUPS,
  GROUP_ORDER,
} from '../src/docs/reference';

/**
 * The reference, kept honest.
 *
 * Documentation rots because nothing fails when it does — the same argument
 * `apps/api/test/docs/api-reference.test.ts` makes about its own. That one can
 * lean on discovery: its routes *are* the code. This one cannot, because ingot
 * has no `/docs` endpoint yet and these entries are written down, so what is
 * checked here is everything that can be checked without the service: that the
 * document is internally consistent, that every anchor the sidebar offers is a
 * section that exists, and that nothing in it throws when rendered.
 *
 * When ingot grows a reference endpoint, the test worth adding beside these is
 * the one that fails when a route exists there and not here.
 */

describe('the reference', () => {
  it('describes every route the service serves', () => {
    // Guards the guards: an empty list would make most of this file pass
    // vacuously. Seventeen is what `apps/ingot` registers today — four
    // controllers under `/api/v1`, two version-neutral, two MCP.
    expect(ENDPOINTS.length).toBe(17);
  });

  it('gives every endpoint an anchor of its own', () => {
    const ids = ENDPOINTS.map((endpoint) => endpoint.id);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it('uses anchors a URL can carry', () => {
    const bad = ENDPOINTS.filter((endpoint) => !/^[a-z0-9-]+$/.test(endpoint.id));
    expect(bad.map((endpoint) => endpoint.id)).toEqual([]);
  });

  it('files every endpoint under a group the page renders', () => {
    const rendered = new Set<EndpointGroup>(GROUP_ORDER);
    const orphaned = ENDPOINTS.filter((endpoint) => !rendered.has(endpoint.group));

    expect(orphaned.map((endpoint) => endpoint.id)).toEqual([]);
  });

  /**
   * `GROUPS` is a `Record` over the enum, so a group without a heading will not
   * compile. `GROUP_ORDER` is an array and has no such guarantee — a member
   * added to the enum and forgotten here is a section that silently does not
   * render.
   */
  it('renders every group exactly once', () => {
    expect([...GROUP_ORDER].sort()).toEqual(Object.keys(GROUPS).sort() as EndpointGroup[]);
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length);
  });

  it('puts something in every endpoint’s second column', () => {
    // The layout is two columns. One with nothing in it is a hole in the page,
    // and `sample` and `asideChips` are alternatives rather than options.
    const empty = ENDPOINTS.filter(
      (endpoint) => Boolean(endpoint.sample) === Boolean(endpoint.asideChips),
    );

    expect(empty.map((endpoint) => endpoint.id)).toEqual([]);
  });

  it('gives every path the prefix the service actually serves', () => {
    const wrong = ENDPOINTS.filter((endpoint) => !endpoint.path.startsWith('/api/'));
    expect(wrong.map((endpoint) => endpoint.path)).toEqual([]);
  });

  /**
   * The three unauthenticated routes, named.
   *
   * This is the assertion worth having in the file. Every other entry here is
   * a rendering mistake; marking a route `open` that is not — or, worse,
   * failing to notice that a fourth one has appeared — is documentation that
   * tells a reader they need no key for something that holds their data.
   */
  it('says a route needs no key only where that is true', () => {
    const open = ENDPOINTS.filter((endpoint) => endpoint.auth === Auth.Open).map(
      (endpoint) => endpoint.path,
    );

    expect(open.sort()).toEqual(['/api/health', '/api/v1/accounts', '/api/versions']);
  });
});

describe('the page', () => {
  it('renders every endpoint without throwing', () => {
    for (const endpoint of ENDPOINTS) {
      const markup = renderToStaticMarkup(<EndpointRow endpoint={endpoint} />);

      expect(markup).toContain(`id="${endpoint.id}"`);
      expect(markup).toContain(endpoint.method);
    }
  });

  /**
   * Every link in the sidebar lands somewhere.
   *
   * The endpoint anchors come from the same list the rows do, so those cannot
   * drift. The four under "Start here" are hand-written against sections in
   * `page.tsx`, and this is what stops one of them from quietly becoming a link
   * to nothing when a section is renamed.
   */
  it('offers no anchor that is not a section', () => {
    const anchors = [...renderToStaticMarkup(<DocsNav />).matchAll(/href="#([^"]+)"/g)].flatMap(
      (match) => (match[1] ? [match[1]] : []),
    );

    expect(anchors.length).toBeGreaterThan(ENDPOINTS.length);

    const targets = new Set<string>([
      ...ENDPOINTS.map((endpoint) => endpoint.id),
      ...BASICS.flatMap((basic) => (basic.id ? [basic.id] : [])),
      // The sections `page.tsx` declares itself.
      'quickstart',
      'errors',
      'reference',
    ]);

    expect(anchors.filter((anchor) => !targets.has(anchor))).toEqual([]);
  });
});
