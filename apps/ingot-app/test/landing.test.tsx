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

/** The landing page. A landing build offers no console: `routesFor` returns null for it. */

describe('the site modes', () => {
  it('offers no console in a landing build', () => {
    expect(routesFor(SiteMode.Landing).dashboard).toBeNull();
  });

  it('offers one in a dashboard build', () => {
    expect(routesFor(SiteMode.Dashboard).dashboard).toBe('/dashboard/');
  });

  /** The reference moves: `/` in a dashboard build, `/docs` in a landing one. */
  it('puts the reference somewhere in both', () => {
    expect(routesFor(SiteMode.Dashboard).docs).toBe('/');
    expect(routesFor(SiteMode.Landing).docs).toBe('/docs/');
  });

  /** Every hand-written link carries `basePath`. */
  it('carries the base path into every hand-written link', () => {
    const routes = routesFor(SiteMode.Landing, '/ingot');

    expect(routes.home).toBe('/ingot/');
    expect(routes.docs).toBe('/ingot/docs/');
    expect(routes.deployment).toBe('/ingot/deployment/');
  });

  /** The deployment page exists only in a landing build. */
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

  /** Every header anchor names a section rendered below it. */
  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  /** The hero says it is self-hosted. */
  it('says it is self-hosted in the hero', () => {
    // Assert both bounds first: a slice from a missing marker is the whole document.
    const heroStart = markup.indexOf('class="hero"');
    const heroEnd = markup.indexOf('class="landsection"');

    expect(heroStart).toBeGreaterThan(-1);
    expect(heroEnd).toBeGreaterThan(heroStart);
    expect(markup.slice(heroStart, heroEnd)).toContain('Self-hosted');
  });

  /** No hosted-looking address on the page. */
  it('advertises no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });

  /** The hero renders the shared lede. */
  it('puts the shared lede in the hero, where the preview promised it', () => {
    expect(markup).toContain(LEDE);
  });
});

/** `.code` scrolls rather than wraps; 62 is the narrowest column any sample renders in. */
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
        // Spread rather than `.length`: `…` and `—` are one glyph each in a monospace face.
        .filter((line) => [...line].length > 62)
        .map((line) => `${name}: ${line}`),
    );

    expect(overlong).toEqual([]);
  });

  /**
   * JSON samples only (`AI_SDK_TOOL` is TypeScript). Rules out piling a value
   * and its closing braces onto one line; a line that opens and closes in one
   * breath is fine, so a line offends only when it closes more than it opened.
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

  /** All three retrieval modes present: `text`, `match_bm25`, and a plain WHERE. */
  it('shows all three of the ways it says can be combined', () => {
    expect(RETRIEVAL).toContain('"text"');
    expect(RETRIEVAL).toContain('array_cosine_similarity(body_vec, $q)');
    expect(RETRIEVAL).toContain('match_bm25');
    expect(RETRIEVAL).toContain('WHERE region');
  });

  /** `$q` binds only when `text` and `sql` arrive together. */
  it('sends the text alongside the SQL that binds it', () => {
    const hybrid = RETRIEVAL.slice(RETRIEVAL.indexOf('# or all three'));

    expect(hybrid).toContain('"text"');
    expect(hybrid).toContain('$q');
  });
});

/** The agent-loop diagram. Arrowheads are `::after` per cell, so the node count matters. */
describe('the agent loop', () => {
  const markup = renderToStaticMarkup(<LandingPage />);

  it('draws every node of the wire', () => {
    for (const node of HARNESS) {
      expect(markup).toContain(node.title);
      expect(markup).toContain(node.wire);
    }
  });

  /** `.wire-lane` is `repeat(4, 1fr)`; the lane must stay four cells. */
  it('keeps the lane to the four cells the grid is cut for', () => {
    expect(HARNESS.length).toBe(4);
  });

  /** Uses AI SDK 5 names: `parameters` became `inputSchema`, `maxSteps` became `stopWhen`. */
  it('shows the AI SDK 5 names rather than the ones they replaced', () => {
    expect(AI_SDK_TOOL).toContain('inputSchema');
    expect(AI_SDK_TOOL).not.toContain('parameters:');
    expect(SDK_NOTES.map((note) => note.hint).join(' ')).toContain('stepCountIs');
  });

  /** `execute` is handed `toolCallId`; the sample passes it as the receipt's `externalId`. */
  it("passes the tool-call id in as the receipt's external id", () => {
    expect(AI_SDK_TOOL).toContain('externalId: toolCallId');
  });

  /** Both numbers of the size comparison are on the page. */
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

/** Every run target renders identically — the same four slots. */
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

  /** Asserted on this page rather than the header, which reads the build's mode. */
  it('renders the same rows the deployment page does', () => {
    const deployment = renderToStaticMarkup(<DeploymentPage />);

    for (const page of [markup, deployment]) {
      for (const target of RUN_TARGETS) {
        expect(page).toContain(`id="${target.id}"`);
        expect(page).toContain(target.title);
      }

      // Four labelled slots per row, on both pages.
      const slots = page.match(/class="label label-sm target-slot"/g) ?? [];
      expect(slots.length).toBe(RUN_TARGETS.length * 4);
    }
  });

  /** Every target is reachable from the section head. */
  it('offers a jump to every target from the head', () => {
    for (const target of RUN_TARGETS) {
      expect(markup).toContain(`href="#${target.id}"`);
    }
  });

  /** The hero button jumps to `#run-local`, so the first target's id is load-bearing. */
  it('keeps the anchor the hero button jumps to', () => {
    expect(RUN_TARGETS[0]?.id).toBe('run-local');
  });

  /** Every target's `more` link is absolute or root-relative, not empty. */
  it('points each target at a longer answer', () => {
    for (const target of RUN_TARGETS) {
      expect(target.more.href).toMatch(/^(https:\/\/|\/)/);
      expect(markup).toContain(`href="${target.more.href}"`);
    }
  });

  /** Rows are numbered by position, padded to two digits. */
  it('numbers the rows by position', () => {
    const numbers = [...markup.matchAll(/class="target-num">(\d\d) ·/g)].map((match) => match[1]);

    expect(numbers).toEqual(RUN_TARGETS.map((_, index) => String(index + 1).padStart(2, '0')));
  });
});
