import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPage } from '../src/landing/landing-page';
import { FEATURES, SPEAKS, STEPS } from '../src/landing/sections';
import { SiteMode, routesFor } from '../src/site/mode';

/**
 * The landing page, and the promise the mode makes.
 *
 * The thing worth holding up here is not that the page renders — it is that a
 * landing build offers no console. That is enforced in two places and this
 * checks the one a test can reach: `routesFor` is what every link asks for the
 * console's address, and in landing mode the answer is `null`, so a header or
 * a sidebar has nothing to render. The other place is `next.config.ts`, which
 * drops the route from the build entirely; only a build can show that, and
 * `out/dashboard` not existing is what shows it.
 */

describe('the site modes', () => {
  it('offers no console in a landing build', () => {
    expect(routesFor(SiteMode.Landing).dashboard).toBeNull();
  });

  it('offers one in a dashboard build', () => {
    expect(routesFor(SiteMode.Dashboard).dashboard).toBe('/dashboard/');
  });

  /**
   * The reference exists in both, and moves. It is the front page of a
   * dashboard build and `/docs` of a landing one, because a landing build
   * needs `/` for the landing page — so a link to it cannot be written down
   * and has to be asked for.
   */
  it('puts the reference somewhere in both', () => {
    expect(routesFor(SiteMode.Dashboard).docs).toBe('/');
    expect(routesFor(SiteMode.Landing).docs).toBe('/docs/');
  });

  /**
   * GitHub Pages serves a project site from `/<repo>/`, and Next prepends
   * `basePath` to its own URLs but not to an `href` written by hand. Every
   * hand-written one on the site comes from here, so this is where that is
   * either true or quietly not.
   */
  it('carries the base path into every hand-written link', () => {
    const routes = routesFor(SiteMode.Landing, '/ingot');

    expect(routes.home).toBe('/ingot/');
    expect(routes.docs).toBe('/ingot/docs/');
  });
});

describe('the landing page', () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  it('renders every section it is given without throwing', () => {
    for (const step of STEPS) expect(markup).toContain(step.title);
    for (const feature of FEATURES) expect(markup).toContain(feature.title);
    for (const thing of SPEAKS) expect(markup).toContain(thing);
  });

  /**
   * Every jump the page offers lands somewhere.
   *
   * The header's anchors are written in `landing-page.tsx` and the sections
   * they name are written a few lines below them, which is exactly the
   * arrangement that drifts when a section is renamed — the same guard
   * `reference.test.tsx` puts on the sidebar.
   */
  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  /**
   * Ingot is self-hosted, and the page has to say so before somebody has read
   * to the bottom looking for a sign-up button that is not there.
   */
  it('says it is self-hosted in the hero', () => {
    // Both bounds are asserted before they are used: a `slice` from a missing
    // marker would be the whole document, and this would pass by finding the
    // word further down — which is the failure it exists to catch.
    const heroStart = markup.indexOf('class="hero"');
    const heroEnd = markup.indexOf('class="landsection"');

    expect(heroStart).toBeGreaterThan(-1);
    expect(heroEnd).toBeGreaterThan(heroStart);
    expect(markup.slice(heroStart, heroEnd)).toContain('Self-hosted');
  });

  /**
   * The addresses on this page are a self-hoster's, because those are the only
   * ones that exist. A hosted-looking one here is the mistake the whole mode is
   * about — and `reference.test.tsx` holds the same line on the docs.
   */
  it('advertises no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });
});
