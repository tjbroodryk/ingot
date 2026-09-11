import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploymentPage } from '../src/deployment/deployment-page';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { RUN_TARGETS } from '../src/deployment/targets';

/**
 * The deployment page, which is two lists stapled together and therefore two
 * ways to come apart.
 *
 * Its sidebar is derived from `targets.ts` and from `dependencies.ts`, and its
 * sections are rendered from the same two — so what is worth holding up is not
 * that either renders, but that the halves agree: every link in the sidebar
 * lands on a section, and every section is reachable from the sidebar. The
 * reference makes the first of those assertions about its own nav; this makes
 * both, because this page's nav spans two sources and the reference's spans
 * one.
 */

describe('the deployment page', () => {
  const markup = renderToStaticMarkup(<DeploymentPage />);

  it('renders both halves without throwing', () => {
    for (const target of RUN_TARGETS) expect(markup).toContain(target.title);
    for (const dependency of [...REQUIRED, ...OPTIONAL]) expect(markup).toContain(dependency.title);
    for (const absence of NOT_NEEDED) expect(markup).toContain(absence.title);
  });

  /**
   * Every jump the page offers — the sidebar's, the header's, and the closing
   * band's `#run-local` — lands on a section that exists. That last one is the
   * one this catches: it is written by hand in the page and the id it names
   * comes from `targets.ts`, so renaming the first target would otherwise
   * leave the page's own call to action pointing at nothing.
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
   * And the other direction, which the reference does not need and this does:
   * a target or a dependency that renders a section nothing links to is one
   * somebody scrolls past rather than finds.
   */
  it('links to every section it renders', () => {
    const anchors = new Set(
      [...markup.matchAll(/class="navlink" href="#([^"]+)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    );

    for (const id of [
      ...RUN_TARGETS.map((target) => target.id),
      ...[...REQUIRED, ...OPTIONAL].map((dependency) => dependency.id),
    ]) {
      expect(anchors).toContain(id);
    }
  });

  /**
   * What is worth holding up here is not that the targets render — it is that
   * they render *identically*, because the claim the page makes is that every
   * way of running Ingot answers the same four questions. A target added later
   * with a slot quietly left thin is the failure this guards against, and it is
   * one nobody notices by looking at the page: the row still draws.
   */
  it('gives every target all four slots', () => {
    for (const target of RUN_TARGETS) {
      expect(markup).toContain(`id="${target.id}"`);
      expect(target.needs.length).toBeGreaterThan(0);
      expect(target.run.length).toBeGreaterThan(0);
      expect(target.check.length).toBeGreaterThan(0);
      expect(target.catches.length).toBeGreaterThan(0);
    }

    // Counted rather than named, because it is the arithmetic that fails when
    // a slot is dropped from the shared component.
    const slots = markup.match(/class="label label-sm target-slot"/g) ?? [];
    expect(slots.length).toBe(RUN_TARGETS.length * 4);
  });

  /**
   * The landing hero's primary button deep-links to `#run-local` on this page,
   * so the first target's anchor is load-bearing in a way the others are not.
   * The fragment is written down in `landing-page.tsx` and the id in
   * `targets.ts`; this is the seam.
   */
  it('keeps the anchor the landing hero jumps to', () => {
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
   * renumbers the ones after it instead of colliding with one of them.
   */
  it('numbers the rows by position', () => {
    const numbers = [...markup.matchAll(/class="target-num">(\d\d) ·/g)].map((match) => match[1]);

    expect(numbers).toEqual(RUN_TARGETS.map((_, index) => String(index + 1).padStart(2, '0')));
  });

  /**
   * The same line the reference and the landing page hold: Ingot is
   * self-hosted, so every address on this page is one the reader brings.
   */
  it('names no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });
});
