import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublishedTable } from '../src/benchmarks/benchmarks';
import { TABLES } from '../src/benchmarks/benchmarks';
import { SiteMode, routesFor } from '../src/site/mode';
import { WHY } from '../src/text/why-text';
import {
  ABSTRACT,
  CONCLUSION,
  evidence,
  HYPOTHESIS,
  INTRODUCTION,
  WHY_SECTIONS,
} from '../src/why/why';
import { WhyPage } from '../src/why/why-page';

describe('the why page', () => {
  const markup = renderToStaticMarkup(<WhyPage />);

  it('renders the abstract and every section', () => {
    expect(markup).toContain(ABSTRACT);
    for (const section of WHY_SECTIONS) expect(markup).toContain(`id="${section.id}"`);
    for (const claim of HYPOTHESIS.claims) expect(markup).toContain(claim.text);
  });

  /**
   * The contrast only works if the SQL follows the value the prose names:
   * `catalog` in one payload and `svc:catalog` in the next.
   */
  it('joins on the value the introduction says links the payloads', () => {
    expect(INTRODUCTION.joins.join(' ')).toContain('`svc:catalog`');
    expect(INTRODUCTION.contrast.exact.sql).toContain("'svc:' || i.service");
  });

  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  it('advertises no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });
});

/**
 * The evidence is computed, so what is worth asserting is that it follows the
 * run: the figures on the page are the file's, and a run that goes the other
 * way turns the verdict with it.
 */
describe('the evidence on the why page', () => {
  const table = TABLES[0] ?? null;

  it('prints the published figures, not typed ones', () => {
    const found = evidence(table);
    if (!found) return;
    const markup = renderToStaticMarkup(<WhyPage />);
    expect(markup).toContain(`${Math.round(found.ours.accuracy * 100)}%`);
    expect(markup).toContain(`${found.contextRatio.toFixed(1)}×`);
    expect(markup).toContain(found.runDate);
  });

  const at = (ours: Record<string, number>, baseline: Record<string, number>): PublishedTable => {
    const adapter = (name: string, byCategory: Record<string, number>) => ({
      name,
      runs: 3,
      accuracy: 0.5,
      stderr: 0,
      f1: 0.5,
      evidenceRecall: null,
      evidencePrecision: null,
      toolCalls: name === 'vector' ? 8 : 3,
      contextTokens: name === 'vector' ? 40000 : 4000,
      runMs: 1,
      callMs: 1,
      failures: 0,
      byCategory,
    });
    const base = table as PublishedTable;
    return {
      ...base,
      categories: Object.keys(ours),
      adapters: [adapter('ingot-rest', ours), adapter('vector', baseline)],
    };
  };

  it('says H3 fails when Ingot falls behind on semantic questions', () => {
    if (!table) return;
    const found = evidence(at({ semantic: 0.8 }, { semantic: 1 }));
    expect(found?.findings).toContain('H3 does not hold');
  });

  it('says H1 fails when the baseline matches on a structured class', () => {
    if (!table) return;
    const found = evidence(at({ ordering: 1, join: 0.6 }, { ordering: 0.3, join: 0.6 }));
    expect(found?.findings).toContain('H1 does not hold');
  });

  it('says both hold, naming the widest gap, when they do', () => {
    if (!table) return;
    const found = evidence(at({ ordering: 1, join: 0.9 }, { ordering: 0.3, join: 0.6 }));
    expect(found?.findings).toContain('H1 and H2 hold: the gap is widest on ordering');
  });
});

describe('the why route', () => {
  it('exists in a landing build only', () => {
    expect(routesFor(SiteMode.Landing).why).toBe('/why/');
    expect(routesFor(SiteMode.Dashboard).why).toBeNull();
  });

  it('carries the base path, like every other hand-written link', () => {
    expect(routesFor(SiteMode.Landing, '/ingot').why).toBe('/ingot/why/');
  });
});

describe('the why page as markdown', () => {
  const document = WHY.render();

  it('carries the argument and the evidence', () => {
    expect(document).toContain(ABSTRACT);
    for (const item of CONCLUSION.open) expect(document).toContain(item);
    const found = evidence();
    if (found) expect(document).toContain(found.findings);
  });
});
