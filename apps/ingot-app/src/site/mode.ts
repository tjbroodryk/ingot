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
   * landing page, `/docs` is the reference, `/deployment` is how to run one
   * and what it costs you in infrastructure, and that is the whole site.
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
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Where each page is, for one mode. */
export interface SiteRoutes {
  readonly home: string;
  /** The reference. Its own page in a landing build; the front page otherwise. */
  readonly docs: string;
  /** The console, or `null` where the build does not have one. */
  readonly dashboard: string | null;
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
    deployment: landing ? `${basePath}/deployment/` : null,
  };
}

const ROUTES = routesFor(MODE);

export const HOME_HREF = ROUTES.home;
export const DOCS_HREF = ROUTES.docs;
export const DASHBOARD_HREF = ROUTES.dashboard;
export const DEPLOYMENT_HREF = ROUTES.deployment;

/**
 * Where the source is, which on a self-hosted-only project is the sign-up
 * link — there is nothing to sign up to, and running it is how you get it.
 */
export const REPO_URL = 'https://github.com/tjbroodryk/ingot';
