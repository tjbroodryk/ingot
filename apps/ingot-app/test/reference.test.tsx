import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EndpointRow } from '../src/docs/endpoint-row';
import { DocsNav } from '../src/docs/docs-nav';
import { BASICS } from '../src/docs/page-sections';
import { ReferencePage } from '../src/docs/reference-page';
import { Auth, ENDPOINTS, type EndpointGroup, GROUPS, GROUP_ORDER } from '../src/docs/reference';

/**
 * The reference. Ingot has no `/docs` endpoint, so entries are written down;
 * what is checked is internal consistency — every anchor is a section, nothing
 * throws when rendered.
 */

describe('the reference', () => {
  it('describes every route the service serves', () => {
    // An empty list would make the rest pass vacuously. Seventeen is what the service registers today.
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

  /** `GROUP_ORDER` is an array with no compile-time guard, unlike the `GROUPS` record. */
  it('renders every group exactly once', () => {
    expect([...GROUP_ORDER].sort()).toEqual(Object.keys(GROUPS).sort() as EndpointGroup[]);
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length);
  });

  it('puts something in every endpoint’s second column', () => {
    // Two columns; `sample` and `asideChips` are alternatives, so exactly one is set.
    const empty = ENDPOINTS.filter(
      (endpoint) => Boolean(endpoint.sample) === Boolean(endpoint.asideChips),
    );

    expect(empty.map((endpoint) => endpoint.id)).toEqual([]);
  });

  it('gives every path the prefix the service actually serves', () => {
    const wrong = ENDPOINTS.filter((endpoint) => !endpoint.path.startsWith('/api/'));
    expect(wrong.map((endpoint) => endpoint.path)).toEqual([]);
  });

  /** Marking a route `open` that is not tells a reader they need no key for their data. */
  it('says a route needs no key only where that is true', () => {
    const open = ENDPOINTS.filter((endpoint) => endpoint.auth === Auth.Open).map(
      (endpoint) => endpoint.path,
    );

    // Two, and neither writes.
    expect(open.sort()).toEqual(['/api/health', '/api/versions']);
  });
});

describe('the page', () => {
  /** No hosted-looking address, across the sample strings and the closing band. */
  it('names no address nobody can reach', () => {
    expect(renderToStaticMarkup(<ReferencePage />)).not.toContain('ingot.dev');
  });

  it('renders every endpoint without throwing', () => {
    for (const endpoint of ENDPOINTS) {
      const markup = renderToStaticMarkup(<EndpointRow endpoint={endpoint} />);

      expect(markup).toContain(`id="${endpoint.id}"`);
      expect(markup).toContain(endpoint.method);
    }
  });

  /** Every sidebar anchor names a section; the hand-written ones can drift, the endpoint ones cannot. */
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
