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
 * The one page on the site that argues rather than describes, held to a
 * stricter standard than the ones that describe.
 *
 * A reference that is wrong is a reader typing the wrong field name and
 * finding out in a second. An *argument* that is wrong is somebody adopting a
 * shape for their system on the strength of a claim the service does not
 * actually make — which they find out about much later, and expensively. So
 * what is asserted here is not that the page renders: it is that the four
 * samples still show the thing the copy around them says they show.
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

  /**
   * The header's anchors are written at the top of the page and the sections
   * they name are written a few hundred lines below them — the same drift
   * `landing.test.tsx` guards against, in the file most likely to have a
   * section renamed while somebody is rewriting the argument.
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
   * The page's lede is the same string its `description` is, for the reason
   * the landing page's is: a visitor arriving from a search has read the
   * preview first, and two copies of a pitch drift on the edit that only
   * remembers one.
   */
  it('puts the shared lede in the hero, where the preview promised it', () => {
    expect(markup).toContain(WHY_LEDE);
  });

  /** The same line the rest of the site holds: no address anybody can reach. */
  it('advertises no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });

  /**
   * The limit under the scopes, which is the one claim on this page somebody
   * could build on and be disappointed by later — a query resolves the tables
   * of one ingot, and there is no statement that spans two. A section that
   * offered four ways to scope a memory without saying that would be selling
   * a decision while hiding what it decides.
   */
  it('says what choosing a grain costs you', () => {
    expect(markup).toContain('there is no query across two');
  });
});

/**
 * The samples, which are the argument rather than an illustration of it.
 *
 * Each of the four is doing one job, and each would still render perfectly
 * well after losing the line that does it — which is the failure these catch.
 */
describe('the samples on the why page', () => {
  /**
   * The join is the page. Three tables in one FROM clause is the claim that
   * "a vector store cannot answer this" rests on, and a sample tidied down to
   * two would leave the copy making an argument the figure no longer shows.
   */
  it('writes into three tables and reads back from all three', () => {
    for (const table of ['contacts', 'invoices', 'tickets']) {
      expect(THREE_TOOLS).toContain(`"table": "${table}"`);
      expect(THE_JOIN).toContain(table);
    }

    expect([...THE_JOIN.matchAll(/\bJOIN\b/g)]).toHaveLength(2);
  });

  /**
   * And that it is a question none of the three tools could have answered on
   * its own: the aggregate and the correlated date range are what make it one,
   * rather than three lookups printed next to each other.
   */
  it('asks something no single tool call could have', () => {
    expect(THE_JOIN).toContain('count(*)');
    expect(THE_JOIN).toContain("INTERVAL '30 days'");
  });

  /**
   * The reconciliation with embeddings, which only works if the sample really
   * does rank *inside* a join — otherwise it is the landing page's retrieval
   * sample again, making a weaker point in a section that claims a stronger
   * one.
   */
  it('ranks by meaning inside a join, not beside one', () => {
    expect(VECTOR_COLUMN).toContain('array_cosine_similarity(n.body_vec, $q)');
    expect(VECTOR_COLUMN).toContain('JOIN contacts');
    // `$q` is bound only when `text` and `sql` arrive together, so the sample
    // is wrong the moment somebody tidies the `text` line out of it.
    expect(VECTOR_COLUMN).toContain('"text"');
  });

  /**
   * The ownership sample is the only one on the site that shows Ingot *not*
   * running, and it is honest in two places that would be easy to lose in an
   * edit: the current generation is the whole table, and the last few minutes
   * of writes are not in it.
   */
  it('reads the base tier without the service, and says what is missing', () => {
    expect(OWN_IT).toContain('read_parquet(');
    expect(OWN_IT).toContain('gen-000003');
    expect(OWN_IT).toContain('still in your Postgres');
  });

  /**
   * The same 62-column bound `landing.test.tsx` holds its samples to, and for
   * the same reason: `.code` scrolls rather than wraps, so an over-long line
   * is the half of the sample that made the point sitting off the right edge
   * of a pane, with nothing on the page to say so.
   */
  it('keeps every line inside the narrowest pane it renders in', () => {
    const samples = { THREE_TOOLS, THE_JOIN, VECTOR_COLUMN, OWN_IT };

    const overlong = Object.entries(samples).flatMap(([name, sample]) =>
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
});

/**
 * Where the page is, and where it is not.
 *
 * `/why` belongs to a landing build for the reason `/deployment` does: the
 * other build is the site that ships beside a running service, and the
 * argument for running one has already been had by whoever did. A header that
 * offered a link to a route `next.config.ts` dropped from the build is the
 * failure this rules out.
 */
describe('the why route', () => {
  it('exists in a landing build only', () => {
    expect(routesFor(SiteMode.Landing).why).toBe('/why/');
    expect(routesFor(SiteMode.Dashboard).why).toBeNull();
  });

  it('carries the base path, like every other hand-written link', () => {
    expect(routesFor(SiteMode.Landing, '/ingot').why).toBe('/ingot/why/');
  });
});

/**
 * The markdown half, which for this page is the half more likely to be read:
 * "why would I use this rather than a vector store" is a question asked of an
 * assistant far more often than it is asked of a website.
 */
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
