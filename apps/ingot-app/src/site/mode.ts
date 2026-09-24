/**
 * Which site this build is, and where its pages live. Selected at build time by
 * `NEXT_PUBLIC_INGOT_MODE` (`landing` or `dashboard`); the two modes have
 * different routes.
 */

export enum SiteMode {
  /** The public page in front of the project: `/` landing, `/docs`, `/why`, `/deployment`. */
  Landing = 'landing',
  /** The site served beside a running service: `/` is the reference, `/dashboard` the console. */
  Dashboard = 'dashboard',
}

/** Anything other than `landing` is a dashboard build. */
export const MODE: SiteMode =
  process.env.NEXT_PUBLIC_INGOT_MODE === 'landing' ? SiteMode.Landing : SiteMode.Dashboard;

export const IS_LANDING = MODE === SiteMode.Landing;

/**
 * The subdirectory the site is served from, if any. Next prepends it to `<Link>`
 * and its own assets, but not to a hand-written `href`.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * The origin this build is served from where known (`https://…`, no trailing
 * slash); empty otherwise. Files read off-site (`Sitemap:`, sitemap `<loc>`,
 * canonical URLs) are written only when it is set. Pairs with {@link BASE_PATH}.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');

/**
 * A path on this site as an absolute URL once {@link SITE_URL} is set,
 * root-relative until then. Expects a path already carrying {@link BASE_PATH}.
 */
export function absolute(path: string): string {
  return `${SITE_URL}${path}`;
}

/** Where each page is, for one mode. */
export interface SiteRoutes {
  readonly home: string;
  /** The reference. Its own page in a landing build; the front page otherwise. */
  readonly docs: string;
  /** The console, or `null` where the build does not have one. */
  readonly dashboard: string | null;
  /** Why the service is shaped the way it is. `null` in a dashboard build. */
  readonly why: string | null;
  /** How to run one. `null` in a dashboard build. */
  readonly deployment: string | null;
  /** What an agent gets back out, measured. `null` in a dashboard build. */
  readonly benchmarks: string | null;
}

/** The route map for a mode, so what a mode offers can be asserted rather than only observed. */
export function routesFor(mode: SiteMode, basePath: string = BASE_PATH): SiteRoutes {
  const landing = mode === SiteMode.Landing;

  return {
    home: `${basePath}/`,
    docs: landing ? `${basePath}/docs/` : `${basePath}/`,
    dashboard: landing ? null : `${basePath}/dashboard/`,
    why: landing ? `${basePath}/why/` : null,
    deployment: landing ? `${basePath}/deployment/` : null,
    benchmarks: landing ? `${basePath}/benchmarks/` : null,
  };
}

const ROUTES = routesFor(MODE);

export const HOME_HREF = ROUTES.home;
export const DOCS_HREF = ROUTES.docs;
export const DASHBOARD_HREF = ROUTES.dashboard;
export const WHY_HREF = ROUTES.why;
export const DEPLOYMENT_HREF = ROUTES.deployment;
export const BENCHMARKS_HREF = ROUTES.benchmarks;

/** Where the source is. */
export const REPO_URL = 'https://github.com/tjbroodryk/ingot';

/** A file in the repository, on the default branch (`main`). */
export function sourceHref(path: string): string {
  // GitHub: files under `/blob/`, directories under `/tree/`; the wrong one 404s.
  // A trailing dotted segment is a file, anything else a directory.
  const kind = /\.[a-z0-9]+$/i.test(path) ? 'blob' : 'tree';
  return `${REPO_URL}/${kind}/main/${path}`;
}
