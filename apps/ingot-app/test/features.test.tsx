import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpMethod, ENDPOINTS } from '../src/docs/reference';
import { COMBINED, FEATURES, FEATURES_LEDE } from '../src/features/features';
import { FeaturesPage } from '../src/features/features-page';
import { SiteMode, routesFor } from '../src/site/mode';
import { FEATURES_ARTICLE } from '../src/text/features-text';

describe('the features page', () => {
  const markup = renderToStaticMarkup(<FeaturesPage />);

  it('renders every feature and the combined query', () => {
    expect(markup).toContain(FEATURES_LEDE);
    for (const feature of FEATURES) expect(markup).toContain(`id="${feature.id}"`);
    expect(markup).toContain(`id="${COMBINED.id}"`);
  });

  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });
});

/**
 * The design this page was drawn from sold a `fuzzy()`, a two-argument
 * `similarity()` and per-column chunk config, none of which the service has.
 * These keep the samples to what it does.
 */
describe('the samples on the features page', () => {
  const samples = [...FEATURES, COMBINED].map((sample) => sample.request).join('\n');

  it('only calls endpoints the reference documents, as POSTs', () => {
    const documented = new Set(
      ENDPOINTS.filter((endpoint) => endpoint.method === HttpMethod.Post).map((endpoint) =>
        endpoint.path.replace(':account/:ingot', 'acme/ing_01H8Z…'),
      ),
    );
    for (const sample of [...FEATURES, COMBINED]) expect(documented).toContain(sample.path);
  });

  it('uses no search function the engine does not have', () => {
    expect(samples).not.toMatch(/\bfuzzy\s*\(/);
    expect(samples).not.toMatch(/(?<!array_cosine_)\bsimilarity\s*\(/);
  });

  it('ranks by meaning the way the engine binds it: a vector column against $q, with text sent', () => {
    for (const sample of [...FEATURES, COMBINED]) {
      if (!sample.request.includes('array_cosine_similarity')) continue;
      expect(sample.request).toMatch(/array_cosine_similarity\(\s*[\w.]+_vec,\s*\$q\)/);
      expect(sample.request).toContain('"text":');
    }
  });

  it('asks for a receipt by rung, not by flag', () => {
    expect(samples).not.toContain('"receipt": true');
    expect(samples).toMatch(/"receipt": "(none|schema|full)"/);
  });
});

describe('the features route', () => {
  it('exists in a landing build only', () => {
    expect(routesFor(SiteMode.Landing).features).toBe('/features/');
    expect(routesFor(SiteMode.Dashboard).features).toBeNull();
  });
});

describe('the features page as markdown', () => {
  it('carries every sample the page does', () => {
    const text = FEATURES_ARTICLE.render();
    for (const sample of [...FEATURES, COMBINED]) expect(text).toContain(sample.request);
  });
});
