import type { NextConfig } from 'next';

/**
 * The public site for `apps/ingot` — a landing page, an API reference, and a
 * dashboard, of which any given build has two.
 *
 * `output: 'export'` is deliberate and load bearing rather than an
 * optimisation. Nothing on this site reads a request: the reference describes
 * the shape of the contract, which is a property of the build, and the one
 * thing a visitor could personalise — their own account — is behind a key they
 * do not have yet. A static export makes that a fact about the artefact rather
 * than a convention: a page that started reading cookies or a database would
 * fail `next build`, not ship.
 *
 * It also means the whole site is a directory of files, so it can sit behind
 * the same CDN as anything else and never be the reason the API is down.
 */

/**
 * Which site this is, decided here because a static export has no server to
 * decide it later. See `src/site/mode.ts` for what each mode means; this file
 * only needs to know which routes exist.
 */
const LANDING = process.env.NEXT_PUBLIC_INGOT_MODE === 'landing';

/**
 * Two of the routes belong to one mode each, and `pageExtensions` is what
 * makes that true of the *files* rather than of a runtime check.
 *
 *   page.landing.tsx     → `/` and `/docs`      in a landing build
 *   page.dashboard.tsx   → `/` and `/dashboard` in a dashboard build
 *
 * A page whose extension is not registered is not a route, so a landing build
 * does not merely hide the console — `out/dashboard` is not written, and there
 * is nothing to find by typing the path. That is the same argument the export
 * itself makes: what the site is should be a property of the artefact.
 *
 * The cost is that `typedRoutes` can only describe the build it is run for, so
 * a link whose target depends on the mode cannot be a `<Link>`. `src/site/
 * mode.ts` owns those, and says so.
 */
const pageExtensions = [LANDING ? 'landing.tsx' : 'dashboard.tsx', 'tsx'];

const config: NextConfig = {
  // Next 16 writes an `AGENTS.md` and a `CLAUDE.md` into the app on first run.
  // This repo already has a `CLAUDE.md` that says how work is done here, and a
  // second one a tool regenerates is a second answer to the same question.
  agentRules: false,
  output: 'export',
  // A static host serves `/docs/index.html` for `/docs`, not for `/docs/`.
  // Trailing slashes make the two spellings the same file rather than a 404
  // that only appears once it is deployed somewhere other than `next dev`.
  trailingSlash: true,
  images: { unoptimized: true },
  typedRoutes: true,
  pageExtensions,
  /**
   * Empty unless the site is served from a subdirectory — which GitHub Pages
   * does for a project site (`/<repo>/`). It is read from the environment
   * rather than hard-coded because it is a property of where a build is
   * deployed, and the same variable is read by `src/site/mode.ts` so a
   * hand-written `href` and Next's own asset URLs cannot disagree.
   */
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
};

export default config;
