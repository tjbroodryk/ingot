import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPage } from '../src/landing/landing-page';
import { FEATURES, SPEAKS, STEPS } from '../src/landing/sections';
import { DeploymentPage } from '../src/deployment/deployment-page';
import { RUN_TARGETS } from '../src/deployment/targets';
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
    expect(routes.deployment).toBe('/ingot/deployment/');
  });

  /**
   * Deployment is the page a landing build has instead of a console, and a
   * dashboard build has neither — its reader is already running the thing the
   * page describes. A header that offers a link to a route `next.config.ts`
   * dropped from the build is the failure this rules out.
   */
  it('offers the deployment page only in a landing build', () => {
    expect(routesFor(SiteMode.Landing).deployment).toBe('/deployment/');
    expect(routesFor(SiteMode.Dashboard).deployment).toBeNull();
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

/**
 * The section that grows.
 *
 * What is worth holding up here is not that three targets render — it is that
 * they render *identically*, because the claim the section makes is that every
 * way of running Ingot answers the same four questions. A target added later
 * with a slot quietly left thin is the failure these guard against, and it is
 * one nobody notices by looking at the page: the row still draws.
 */
describe('the ways to run it', () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  it('gives every target all four slots', () => {
    for (const target of RUN_TARGETS) {
      expect(markup).toContain(`id="${target.id}"`);
      expect(markup).toContain(target.title);
      expect(target.needs.length).toBeGreaterThan(0);
      expect(target.run.length).toBeGreaterThan(0);
      expect(target.check.length).toBeGreaterThan(0);
      expect(target.catches.length).toBeGreaterThan(0);
    }
  });

  /**
   * The header's Deployment item is a fragment, and this is the page that has
   * to contain what it names. It is asserted here rather than by rendering the
   * header, because the header reads the *build's* mode and a test run is a
   * dashboard build — which is the whole reason `routesFor` takes a mode.
   */
  it('renders the same rows the deployment page does', () => {
    const deployment = renderToStaticMarkup(<DeploymentPage />);

    for (const page of [markup, deployment]) {
      for (const target of RUN_TARGETS) {
        expect(page).toContain(`id="${target.id}"`);
        expect(page).toContain(target.title);
      }

      // Four labelled slots per row, on both pages. A row that answered three
      // questions here and four there would make the claim the landing head
      // prints — that none of them is left out — true only where somebody last
      // looked. Counted rather than named, because it is the arithmetic that
      // fails when a slot is dropped from the shared component.
      const slots = page.match(/class="label label-sm target-slot"/g) ?? [];
      expect(slots.length).toBe(RUN_TARGETS.length * 4);
    }
  });

  /**
   * The head's jump row is built from the same list the rows are, so a target
   * added to `targets.ts` is reachable from the top of the section rather than
   * only by scrolling past the ones before it.
   */
  it('offers a jump to every target from the head', () => {
    for (const target of RUN_TARGETS) {
      expect(markup).toContain(`href="#${target.id}"`);
    }
  });

  /**
   * The hero's primary button deep-links into the section rather than to the
   * top of it, so the first target's anchor is load-bearing in a way the
   * others are not. `#run-local` is written down in `landing-page.tsx` and the
   * id is written down in `targets.ts`; this is the seam.
   */
  it('keeps the anchor the hero button jumps to', () => {
    expect(RUN_TARGETS[0]?.id).toBe('run-local');
  });

  /**
   * Every "the longer answer is over there" goes somewhere real. These are the
   * links most likely to rot — a chart README that moves, a heading that gets
   * renamed out from under an anchor — and the cheap half of that is checking
   * the page did not ship one that is empty or relative to nothing.
   */
  it('points each target at a longer answer', () => {
    for (const target of RUN_TARGETS) {
      expect(target.more.href).toMatch(/^(https:\/\/|\/)/);
      expect(markup).toContain(`href="${target.more.href}"`);
    }
  });

  /**
   * The numbers are the rows' positions, so a target inserted in the middle
   * renumbers the ones after it instead of colliding with one of them. Padded
   * to two digits, which is the form the design sets them in.
   */
  it('numbers the rows by position', () => {
    const numbers = [...markup.matchAll(/class="target-num">(\d\d) ·/g)].map((match) => match[1]);

    expect(numbers).toEqual(RUN_TARGETS.map((_, index) => String(index + 1).padStart(2, '0')));
  });
});
