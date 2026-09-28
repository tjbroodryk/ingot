/**
 * The plain-text half of the site: `*.md` pages, the `llms.txt` index, and
 * `robots.txt`. Derived from `src/site/mode.ts`, written after `next build` by
 * `scripts/emit-text.ts`.
 */

import { absolute, BASE_PATH, MODE, REPO_URL, routesFor, SITE_URL, SiteMode } from '../site/mode';
import { BENCHMARKS } from './benchmarks-text';
import { DEPLOYMENT } from './deployment-text';
import { type Article, blocks, bullets, heading } from './markdown';
import { REFERENCE } from './reference-text';
import { WHY } from './why-text';

/** One file, and where under `out/` it goes. */
export interface TextFile {
  /** Relative to the export root. No leading slash — this is a path, not a URL. */
  readonly path: string;
  readonly body: string;
}

/** The concatenation llmstxt.org calls for. */
const FULL = 'llms-full.txt';

/** Absolute by spec; written only once there is an origin. */
const SITEMAP = 'sitemap.xml';

/** The documents this build has, and where each is served. */
function articles(landing: boolean): readonly (Article & { readonly path: string })[] {
  return [
    ...(landing ? [{ ...WHY, path: 'why.md' }] : []),
    ...(landing ? [{ ...BENCHMARKS, path: 'benchmarks.md' }] : []),
    { ...REFERENCE, path: landing ? 'docs.md' : 'index.md' },
    ...(landing ? [{ ...DEPLOYMENT, path: 'deployment.md' }] : []),
  ];
}

/** A link as served: absolute once there is an origin, root-relative until then. `basePath` is prepended either way. */
function link(path: string): string {
  return absolute(`${BASE_PATH}/${path}`);
}

/** The index, in llmstxt.org's format: an H1, a blockquote, then sections of annotated links. */
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

/** The crawlers. A dashboard build disallows its console route. */
function robotsTxt(mode: SiteMode): string {
  // The route, not the string, so it carries `basePath`.
  const dashboard = routesFor(mode).dashboard;

  // Joined with newlines, not `blocks`: a blank line ends a robots group.
  // `Sitemap:` belongs to no group and is set apart.
  return `${blocks(
    '# The reader-facing index is /llms.txt, and the pages it links are markdown.',
    ['User-agent: *', 'Allow: /', ...(dashboard ? [`Disallow: ${dashboard}`] : [])].join('\n'),
    // Absolute or absent: crawlers discard a relative `Sitemap:`.
    SITE_URL && `Sitemap: ${link(SITEMAP)}`,
  )}\n`;
}

/**
 * When each route's content last changed, keyed by route (the same string
 * {@link routesFor} returns). A real per-page date — see {@link sitemapXml}'s
 * `lastmod`. Missing entries emit no `lastmod` at all.
 */
export type LastModified = Readonly<Record<string, string>>;

/** The HTML routes as a sitemap. Written only where {@link SITE_URL} is set (every `<loc>` must be absolute). */
function sitemapXml(mode: SiteMode, lastmod: LastModified = {}): string {
  const routes = routesFor(mode);
  const pages = [routes.home, routes.why, routes.docs, routes.deployment, routes.benchmarks].filter(
    (route): route is string => route !== null,
  );

  // No build-time date: `lastmod` is the section's last commit or nothing, so it
  // never claims a page changed when only the build ran. See `scripts/emit-text.ts`.
  const url = (route: string): string => {
    const at = lastmod[route];
    const loc = `<loc>${absolute(route)}</loc>`;
    return at ? `  <url>${loc}<lastmod>${at}</lastmod></url>` : `  <url>${loc}</url>`;
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...[...new Set(pages)].map(url),
    '</urlset>',
  ].join('\n');
}

/** Everything this build writes beside its HTML. The sitemap is not always present; see `sitemapXml`. */
export function textFiles(mode: SiteMode = MODE, lastmod: LastModified = {}): readonly TextFile[] {
  const pages = articles(mode === SiteMode.Landing);

  return [
    ...pages.map((page) => ({ path: page.path, body: page.render() })),
    { path: FULL, body: llmsFullTxt(pages) },
    { path: 'llms.txt', body: llmsTxt(pages) },
    { path: 'robots.txt', body: robotsTxt(mode) },
    ...(SITE_URL ? [{ path: SITEMAP, body: `${sitemapXml(mode, lastmod)}\n` }] : []),
  ];
}
