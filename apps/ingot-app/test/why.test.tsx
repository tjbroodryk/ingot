import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteMode, routesFor } from '../src/site/mode';
import { WhyPage } from '../src/why/why-page';
import {
  COSTS,
  GRAINS,
  LOSSES,
  OWN_IT,
  SQL_NOTES,
  THE_JOIN,
  WHY_LEDE,
  THREE_TOOLS,
  TIERS,
  VECTOR_COLUMN,
} from '../src/why/why';
import { WHY } from '../src/text/why-text';

/**
 * The one page that argues rather than describes. What is asserted is not that
 * it renders but that the four samples still show what the copy says they show.
 */

describe('the why page', () => {
  const markup = renderToStaticMarkup(<WhyPage />);

  it('renders every section it is given without throwing', () => {
    for (const loss of LOSSES) expect(markup).toContain(loss.title);
    for (const note of SQL_NOTES) expect(markup).toContain(note.title);
    for (const grain of GRAINS) expect(markup).toContain(grain.title);
    for (const tier of TIERS) expect(markup).toContain(tier.title);
    for (const cost of COSTS) expect(markup).toContain(cost.item);
  });

  /** Every header anchor names a section written below it. */
  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  /** The hero renders the shared lede. */
  it('puts the shared lede in the hero, where the preview promised it', () => {
    expect(markup).toContain(WHY_LEDE);
  });

  /** No address anybody can reach. */
  it('advertises no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });

  /** The page states the limit: a query resolves one ingot's tables, none spans two. */
  it('says what choosing a grain costs you', () => {
    expect(markup).toContain('there is no query across two');
  });
});

/** The samples. Each does one job and would still render after losing the line that does it. */
describe('the samples on the why page', () => {
  /** Three tables in one FROM clause — the claim a vector store cannot answer this. */
  it('writes into three tables and reads back from all three', () => {
    for (const table of ['contacts', 'invoices', 'tickets']) {
      expect(THREE_TOOLS).toContain(`"table": "${table}"`);
      expect(THE_JOIN).toContain(table);
    }

    expect([...THE_JOIN.matchAll(/\bJOIN\b/g)]).toHaveLength(2);
  });

  /** The aggregate and correlated date range make it one question, not three lookups. */
  it('asks something no single tool call could have', () => {
    expect(THE_JOIN).toContain('count(*)');
    expect(THE_JOIN).toContain("INTERVAL '30 days'");
  });

  /** Ranks by meaning inside a join, not beside one. */
  it('ranks by meaning inside a join, not beside one', () => {
    expect(VECTOR_COLUMN).toContain('array_cosine_similarity(n.body_vec, $q)');
    expect(VECTOR_COLUMN).toContain('JOIN contacts');
    // `$q` binds only when `text` and `sql` arrive together.
    expect(VECTOR_COLUMN).toContain('"text"');
  });

  /** The ownership sample reads the base tier without the service, and says what is missing. */
  it('reads the base tier without the service, and says what is missing', () => {
    expect(OWN_IT).toContain('read_parquet(');
    expect(OWN_IT).toContain('gen-000003');
    expect(OWN_IT).toContain('still in your Postgres');
  });

  /** The same 62-column bound: `.code` scrolls rather than wraps. */
  it('keeps every line inside the narrowest pane it renders in', () => {
    const samples = { THREE_TOOLS, THE_JOIN, VECTOR_COLUMN, OWN_IT };

    const overlong = Object.entries(samples).flatMap(([name, sample]) =>
      sample
        .split('\n')
        // Spread rather than `.length`: `…` and `—` are one glyph each in a monospace face.
        .filter((line) => [...line].length > 62)
        .map((line) => `${name}: ${line}`),
    );

    expect(overlong).toEqual([]);
  });
});

/** `/why` exists in a landing build only. */
describe('the why route', () => {
  it('exists in a landing build only', () => {
    expect(routesFor(SiteMode.Landing).why).toBe('/why/');
    expect(routesFor(SiteMode.Dashboard).why).toBeNull();
  });

  it('carries the base path, like every other hand-written link', () => {
    expect(routesFor(SiteMode.Landing, '/ingot').why).toBe('/ingot/why/');
  });
});

/** The markdown half, the one more likely to be read for this page. */
describe('the why page as markdown', () => {
  const document = WHY.render();

  it('carries the argument, not only the headings', () => {
    for (const loss of LOSSES) expect(document).toContain(loss.title);
    for (const note of SQL_NOTES) expect(document).toContain(note.body);
    for (const grain of GRAINS) expect(document).toContain(grain.body);
    for (const cost of COSTS) expect(document).toContain(cost.item);
  });

  it('carries the samples the page argues from', () => {
    for (const sample of [THREE_TOOLS, THE_JOIN, VECTOR_COLUMN, OWN_IT]) {
      expect(document).toContain(sample);
    }
  });

  it('opens every fence it closes', () => {
    expect(document.split('\n').filter((line) => line === '```').length % 2).toBe(0);
  });
});
