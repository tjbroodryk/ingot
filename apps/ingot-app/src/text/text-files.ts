/**
 * The plain-text half of the site: what a build writes beside its HTML.
 *
 * Three kinds of file, and they answer three different readers:
 *
 *   `*.md`         the documentation pages without the page — what a model is
 *                  handed when somebody pastes a URL at it
 *   `llms.txt`     the index, per llmstxt.org: what this project is and which
 *                  of those files is worth opening
 *   `robots.txt`   the crawlers, which have their own conventions and are not
 *                  served by either of the above
 *
 * Derived from `src/site/mode.ts` rather than listed, for the reason the
 * sidebars are derived from their content modules: a landing build and a
 * dashboard build have different routes, and an index offering `/deployment.md`
 * in a build that has no deployment page would be the same broken-anchor
 * failure `test/deployment.test.tsx` already guards against — one artefact
 * further out, where nothing renders it and nothing would notice.
 *
 * These are written after `next build` by `scripts/emit-text.ts`, because a
 * static export is a directory of files and this is a few more of them. They
 * do not exist under `next dev`.
 */

import { absolute, BASE_PATH, MODE, REPO_URL, routesFor, SITE_URL, SiteMode } from '../site/mode';
import { DEPLOYMENT } from './deployment-text';
import { type Article, blocks, bullets, heading } from './markdown';
import { REFERENCE } from './reference-text';

/** One file, and where under `out/` it goes. */
export interface TextFile {
  /** Relative to the export root. No leading slash — this is a path, not a URL. */
  readonly path: string;
  readonly body: string;
}

/** The concatenation llmstxt.org calls for, for a reader that fetches once. */
const FULL = 'llms-full.txt';

/** Absolute by specification, so it is written only once there is an origin. */
const SITEMAP = 'sitemap.xml';

/**
 * The documents this build has, and where each is served.
 *
 * The reference's path is a function of the mode for the same reason its
 * *route* is: it is the front page of a dashboard build and `/docs` of a
 * landing one. The deployment page belongs to a landing build only — a reader
 * looking at the site that ships beside a running service has already done the
 * thing that page describes.
 */
function articles(landing: boolean): readonly (Article & { readonly path: string })[] {
  return [
    { ...REFERENCE, path: landing ? 'docs.md' : 'index.md' },
    ...(landing ? [{ ...DEPLOYMENT, path: 'deployment.md' }] : []),
  ];
}

/**
 * A link as it will be served: absolute once there is an origin to be absolute
 * about, and root-relative until then.
 *
 * Root-relative is not a placeholder — it is the right answer for a project
 * with no address of its own, because it is correct at every address at once
 * and a self-hoster's copy of this site is served from theirs. What an origin
 * buys is a link that survives being *copied off* the site, which is exactly
 * what happens to an index a model was handed. So both are written properly
 * rather than one being the degenerate case of the other.
 *
 * `basePath` is prepended either way — a GitHub Pages project site adds a
 * `/<repo>/` prefix, and these links are the one place on the site Next will
 * not add it for us.
 */
function link(path: string): string {
  return absolute(`${BASE_PATH}/${path}`);
}

/**
 * The index, in llmstxt.org's format: an H1, a blockquote saying what the
 * project is, then sections of annotated links.
 *
 * Generated from the same list the files are written from, so it cannot name
 * one the build did not write.
 */
function llmsTxt(pages: readonly (Article & { readonly path: string })[]): string {
  return `${blocks(
    heading(1, 'Ingot'),
    '> Durable, typed memory for LLM agents. A tool result is stored as typed columns and read back as SQL or as search, so it outlives the turn without ever entering the context window. Self-hosted: one process, a Postgres, and somewhere to put Parquet.',
    'There is no hosted Ingot — you run it — so every address in these documents is `localhost` or your own. What follows is the site, without the site.',

    heading(2, 'Docs'),
    bullets(pages.map((page) => `[${page.title}](${link(page.path)}): ${page.summary}`)),

    heading(2, 'Optional'),
    bullets([
      `[Everything above, in one file](${link(FULL)}): the same documents concatenated, for a reader that would rather fetch once.`,
      `[Source](${REPO_URL}): the repository. Every claim in these documents is a fact about it.`,
    ]),
  )}\n`;
}

function llmsFullTxt(pages: readonly Article[]): string {
  return `${pages.map((page) => page.render().trimEnd()).join('\n\n---\n\n')}\n`;
}

/**
 * The crawlers.
 *
 * There is no directive for `llms.txt` — it is a convention with no registered
 * robots keyword — so it is named in a comment, which is where somebody
 * looking for it will look and is worth more than an invented field every
 * parser would ignore.
 *
 * A dashboard build hides its console. Not because a crawler could do anything
 * with it, being a bearer key away from every route, but because it is
 * somebody's running deployment and has no business in an index.
 *
 * One caveat this file cannot fix: `robots.txt` is only ever read at the root
 * of an origin. On a GitHub Pages project site the whole export sits under
 * `/<repo>/`, so this is written, served, and never consulted. It is correct
 * on the container image, which serves at the root, and becomes correct on
 * Pages the moment a custom domain is configured — `.github/workflows/
 * pages.yml` drops the prefix in the same breath as it sets the origin.
 */
function robotsTxt(mode: SiteMode): string {
  // The route rather than the string, so it carries `basePath` and cannot
  // name a path this build does not serve.
  const dashboard = routesFor(mode).dashboard;

  // The directives are joined with a newline and not through `blocks`, because
  // a blank line in this file is what *ends* a group: an `Allow` separated
  // from its `User-agent` is a group with no agent, which every parser drops.
  // `Sitemap:` is the exception — it belongs to no group and is conventionally
  // set apart, which is what the blank line before it says.
  return `${blocks(
    '# The reader-facing index is /llms.txt, and the pages it links are markdown.',
    ['User-agent: *', 'Allow: /', ...(dashboard ? [`Disallow: ${dashboard}`] : [])].join('\n'),
    // Absolute or absent: a relative `Sitemap:` is not a lenient spelling, it
    // is a line every crawler discards. Until this build has an origin there
    // is nothing true to write here.
    SITE_URL && `Sitemap: ${link(SITEMAP)}`,
  )}\n`;
}

/**
 * The pages, for a crawler that wants the list rather than the links.
 *
 * The HTML routes only. The markdown beside them is the same document again
 * and would be a duplicate in an index; the console is the thing `robots.txt`
 * just refused, and listing it here would be the two files disagreeing.
 *
 * Written only where {@link SITE_URL} is set, because every `<loc>` in a
 * sitemap must be absolute — there is no relative form of this file to write
 * in the meantime, and an empty one would claim the site has no pages.
 */
function sitemapXml(mode: SiteMode): string {
  const routes = routesFor(mode);
  const pages = [routes.home, routes.docs, routes.deployment].filter(
    (route): route is string => route !== null,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    // No `lastmod`. It is optional, it would have to come from the clock at
    // build time, and a date that moves whenever the site is rebuilt is a
    // claim that every page changed — which is worth less than saying nothing.
    ...[...new Set(pages)].map((route) => `  <url><loc>${absolute(route)}</loc></url>`),
    '</urlset>',
  ].join('\n');
}

/**
 * Everything this build writes beside its HTML.
 *
 * The mode is an argument with the build's own as its default, for the reason
 * `routesFor` in `src/site/mode.ts` takes one: what a mode implies is then
 * something a test can assert about both of them rather than something only
 * the build it happened to run in ever observes.
 *
 * The sitemap is the one file that is not always here. See `sitemapXml`.
 */
export function textFiles(mode: SiteMode = MODE): readonly TextFile[] {
  const pages = articles(mode === SiteMode.Landing);

  return [
    ...pages.map((page) => ({ path: page.path, body: page.render() })),
    { path: FULL, body: llmsFullTxt(pages) },
    { path: 'llms.txt', body: llmsTxt(pages) },
    { path: 'robots.txt', body: robotsTxt(mode) },
    ...(SITE_URL ? [{ path: SITEMAP, body: `${sitemapXml(mode)}\n` }] : []),
  ];
}
