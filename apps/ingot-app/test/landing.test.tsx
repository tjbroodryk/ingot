import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPage } from '../src/landing/landing-page';
import {
  AI_SDK_SEEN,
  AI_SDK_TOOL,
  FEATURES,
  HARNESS,
  LEDE,
  MCP_CONFIG,
  RECALL,
  RECEIPTS,
  REMEMBER,
  RETRIEVAL,
  SDK_NOTES,
  SPEAKS,
  STEPS,
} from '../src/landing/sections';
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

  /**
   * The lede a visitor reads is the same string `layout.tsx` hands a search
   * result and a link preview. That is a constant rather than this test's job
   * — what this holds is the other half, that the hero still renders it, which
   * a rewrite of the JSX could quietly stop doing while `description` went on
   * promising it.
   */
  it('puts the shared lede in the hero, where the preview promised it', () => {
    expect(markup).toContain(LEDE);
  });
});

/**
 * The claim that Ingot retrieves without a vector database beside it.
 *
 * It is the one section whose sample would fail silently if it were wrong:
 * keyword indexing is off until a table asks for it, so a reader who pastes a
 * `match_bm25` query against a fresh table gets an empty result and no reason
 * for it. The sample has to open with the switch, and that ordering is the
 * thing worth holding.
 */
/**
 * The samples are pretty-printed JSON, and pretty-printing is what pushes a
 * line past the pane holding it.
 *
 * `.code` scrolls rather than wraps, so an over-long line is not a wrapped
 * line — it is a horizontal scrollbar under a figure, and the half of the
 * sample that made the point is the half now off the right edge. Nothing about
 * the page says so when it happens, which is why it is asserted here.
 *
 * 62 is the narrowest column any of them renders in: half of `.panel-wide` at
 * its 1040px maximum, less the panel's padding, at the mono face's advance —
 * and, near enough the same number, a `.split-figure` at the width the splits
 * collapse from. Widening a sample means widening `.panel-wide` with it.
 */
describe('the samples on the page', () => {
  const SAMPLES = {
    REMEMBER,
    RECALL,
    RECEIPTS,
    RETRIEVAL,
    AI_SDK_TOOL,
    AI_SDK_SEEN,
    MCP_CONFIG,
  };

  it('keeps every line inside the narrowest pane it renders in', () => {
    const overlong = Object.entries(SAMPLES).flatMap(([name, sample]) =>
      sample
        .split('\n')
        // Spread rather than `.length`: `…` and `—` are one glyph each in a
        // monospace face, and counting them as their UTF-16 size would be
        // counting columns the sample does not occupy.
        .filter((line) => [...line].length > 62)
        .map((line) => `${name}: ${line}`),
    );

    expect(overlong).toEqual([]);
  });

  /**
   * The formatting itself, over the samples that are JSON — `AI_SDK_TOOL` is
   * TypeScript and closes a call as well as an object, so this rule is not
   * about it.
   *
   * The shape being ruled out is `"embed": true } },` — a value and the two
   * braces that close the objects it was nested in, piled onto one line. Every
   * sample here was written that way to fit a narrower pane, and it is what
   * reads as something you would reformat before believing.
   *
   * A line that opens and closes in the same breath is not that and stays
   * allowed: `{ "fts": { "enabled": true } }` is a whole object, and spreading
   * a single setting over five lines would be the other kind of unreadable.
   * The test is the arithmetic — a line only offends when it closes more than
   * it opened, which means it is closing something from a line above.
   */
  it('closes its objects on their own lines', () => {
    const { AI_SDK_TOOL: _typescript, ...json } = SAMPLES;

    for (const [name, sample] of Object.entries(json)) {
      const piled = sample.split('\n').filter((line) => {
        const opened = (line.match(/[{[]/g) ?? []).length;
        const closed = (line.match(/[}\]]/g) ?? []).length;

        return closed > opened && !/^[\s}\],]*$/.test(line);
      });

      expect({ [name]: piled }).toEqual({ [name]: [] });
    }
  });
});

describe('the retrieval sample', () => {
  it('turns keyword indexing on before it uses it', () => {
    const enabled = RETRIEVAL.indexOf('"fts"');
    const used = RETRIEVAL.indexOf('match_bm25');

    expect(enabled).toBeGreaterThan(-1);
    expect(used).toBeGreaterThan(enabled);
  });

  /**
   * The three modes the section names, each present as the thing it actually
   * is: `text` for meaning, `match_bm25` for words, and a WHERE on a column
   * that is neither. A sample that dropped one would leave the copy claiming a
   * hybrid the figure does not show.
   */
  it('shows all three of the ways it says can be combined', () => {
    expect(RETRIEVAL).toContain('"text"');
    expect(RETRIEVAL).toContain('array_cosine_similarity(body_vec, $q)');
    expect(RETRIEVAL).toContain('match_bm25');
    expect(RETRIEVAL).toContain('WHERE region');
  });

  /**
   * `$q` is bound only when `text` and `sql` arrive together, so the hybrid
   * block is wrong the moment somebody tidies the `text` line out of it.
   */
  it('sends the text alongside the SQL that binds it', () => {
    const hybrid = RETRIEVAL.slice(RETRIEVAL.indexOf('# or all three'));

    expect(hybrid).toContain('"text"');
    expect(hybrid).toContain('$q');
  });
});

/**
 * The pair that shows where this goes in somebody else's code.
 *
 * The diagram's own risk is not that it fails to render — it is that the
 * arrowheads are `::after` on every cell but the last, so a fifth node added
 * to `HARNESS` silently keeps the four-column grid and wraps into a second row
 * whose arrows point off the end of the first. The count is asserted here
 * because the CSS cannot assert it and the page still draws either way.
 */
describe('the agent loop', () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  it('draws every node of the wire', () => {
    for (const node of HARNESS) {
      expect(markup).toContain(node.title);
      expect(markup).toContain(node.wire);
    }
  });

  /**
   * `.wire-lane` is `repeat(4, 1fr)` and the rules that clear the left border
   * are written `4n + 1`. Both are arithmetic about this number, in a file the
   * data does not import.
   */
  it('keeps the lane to the four cells the grid is cut for', () => {
    expect(HARNESS.length).toBe(4);
  });

  /**
   * The sample is set against a named version of somebody else's library, and
   * the three names below are the ones that moved in it — `parameters` became
   * `inputSchema`, `maxSteps` became `stopWhen`. A landing page that shows a
   * reader the previous major's API is the same lie as one advertising an
   * address nobody can reach, and it is the kind that ages into being true
   * again if nobody writes it down.
   */
  it('shows the AI SDK 5 names rather than the ones they replaced', () => {
    expect(AI_SDK_TOOL).toContain('inputSchema');
    expect(AI_SDK_TOOL).not.toContain('parameters:');
    expect(SDK_NOTES.map((note) => note.hint).join(' ')).toContain('stepCountIs');
  });

  /**
   * The join between the two halves. `toolCallId` is what `execute` is handed
   * and `externalId` is what `/add` takes; the sample is only worth printing
   * if it shows one being passed as the other, and that is one line somebody
   * tidying the block would not miss.
   */
  it("passes the tool-call id in as the receipt's external id", () => {
    expect(AI_SDK_TOOL).toContain('externalId: toolCallId');
  });

  /**
   * The claim the section makes is a size comparison, and it is only a claim
   * if both numbers are on the page. Either one alone is a number.
   */
  it('prints both sides of the swap it is selling', () => {
    expect(AI_SDK_SEEN).toContain('180 tokens');
    expect(AI_SDK_SEEN).toContain('48,000');
  });

  it('offers a note for each thing the sample leaves out', () => {
    for (const note of SDK_NOTES) {
      expect(markup).toContain(note.title);
      expect(markup).toContain(note.hint);
    }
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
