/**
 * Which site this build is, and where its pages live.
 *
 * One codebase, two artefacts. A static export cannot decide this at run time
 * — there is no run time — so the mode is inlined by `next build` and the two
 * sites are two builds, the same way the API's address already is.
 *
 *   NEXT_PUBLIC_INGOT_MODE=landing     the public page in front of the project
 *   NEXT_PUBLIC_INGOT_MODE=dashboard   what a self-hoster runs beside their
 *                                      service — the default, and unchanged
 *
 * The modes do not differ by a flag on a shared page; they have different
 * routes, and `next.config.ts` drops the ones that do not belong to the build
 * through `pageExtensions`. A landing build has no `/dashboard` to find.
 */

export enum SiteMode {
  /**
   * The page in front of the project. Ingot is self-hosted only, so there is
   * no account to sign into and no console to sign into it with: `/` is the
   * landing page, `/docs` is the reference, `/why` is the argument for the
   * shape of the thing, `/deployment` is how to run one and what it costs you
   * in infrastructure, and that is the whole site.
   */
  Landing = 'landing',
  /**
   * The site that ships beside a running service, in the image and under
   * `bun run dev`. `/` is the reference and `/dashboard` is the console.
   */
  Dashboard = 'dashboard',
}

/**
 * Anything other than `landing` is a dashboard build, rather than an error.
 * The variable is unset in every local checkout and in the image's default
 * build, and the mode that wants no explanation is the one you get for free.
 */
export const MODE: SiteMode =
  process.env.NEXT_PUBLIC_INGOT_MODE === 'landing' ? SiteMode.Landing : SiteMode.Dashboard;

export const IS_LANDING = MODE === SiteMode.Landing;

/**
 * The subdirectory the site is served from, if it is served from one — GitHub
 * Pages puts a project site under `/<repo>/`. Next prepends `basePath` to its
 * own asset URLs and to a `<Link>`, but not to an `href` written by hand, so
 * every hand-written one goes through {@link href} below.
 *
 * Exported because the plain-text build in `src/text/` writes its own links
 * and is not markup, so `<Link>` cannot prepend anything for it.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * The origin this build is served from, where that is known — `https://…`,
 * with no trailing slash.
 *
 * Empty by default, and everything the site writes works with it empty: a page
 * links its own site with a root-relative path, which is right at every
 * address at once. What it is *not* enough for is the handful of files that
 * are read off this site by something that is not on it — `robots.txt`'s
 * `Sitemap:` line and every `<loc>` in the sitemap it points at must be
 * absolute, per their own specifications, and a canonical URL is absolute by
 * definition. So those are written when this is set and left out when it is
 * not, rather than guessed at or written relative and quietly ignored.
 *
 * The pair with {@link BASE_PATH}, not an alternative to it. A GitHub Pages
 * project site is `''` + `/<repo>`; a custom domain at the root is an origin +
 * `''`; a site under a path on a domain of its own is both, and
 * {@link absolute} composes them in that order.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');

/**
 * A path on this site, as far as this build can address it: an absolute URL
 * once {@link SITE_URL} is set, and the root-relative path until then.
 *
 * Takes a path that already carries {@link BASE_PATH} — the routes below are
 * the things worth passing it — so the two halves of the address are composed
 * in one place rather than concatenated at each call.
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
  /**
   * Why the service is shaped the way it is — the argument, rather than the
   * contract. `null` in a dashboard build, for the reason `deployment` is:
   * that site ships beside a running service, and its reader has already been
   * persuaded by whoever deployed it.
   */
  readonly why: string | null;
  /**
   * How to run one — the three places, and the two things each of them needs.
   * `null` in a dashboard build.
   *
   * Not because it would be wrong there — the dependencies are the same — but
   * because that build is the site that ships *beside* a running service, and
   * a reader looking at it has already done the thing the page describes.
   */
  readonly deployment: string | null;
}

/**
 * The route map, as a function of the mode, so that what a mode offers can be
 * asserted rather than only observed in a build.
 *
 * These are strings and their links are plain anchors, not `<Link>`, and that
 * is forced rather than careless: `typedRoutes` generates the union of routes
 * *this* build has, so `/docs` does not typecheck in a dashboard build and
 * `/dashboard` does not typecheck in a landing one. A cast would be a lie in
 * whichever build it was wrong for. `src/docs/docs-nav.tsx` already linked the
 * console this way, for the same reason a static export makes it harmless: the
 * site is a directory of files behind nginx, and a client-side transition
 * between two of them is a convenience rather than the mechanism.
 */
export function routesFor(mode: SiteMode, basePath: string = BASE_PATH): SiteRoutes {
  const landing = mode === SiteMode.Landing;

  return {
    home: `${basePath}/`,
    docs: landing ? `${basePath}/docs/` : `${basePath}/`,
    dashboard: landing ? null : `${basePath}/dashboard/`,
    why: landing ? `${basePath}/why/` : null,
    deployment: landing ? `${basePath}/deployment/` : null,
  };
}

const ROUTES = routesFor(MODE);

export const HOME_HREF = ROUTES.home;
export const DOCS_HREF = ROUTES.docs;
export const DASHBOARD_HREF = ROUTES.dashboard;
export const WHY_HREF = ROUTES.why;
export const DEPLOYMENT_HREF = ROUTES.deployment;

/**
 * Where the source is, which on a self-hosted-only project is the sign-up
 * link — there is nothing to sign up to, and running it is how you get it.
 */
export const REPO_URL = 'https://github.com/tjbroodryk/ingot';
