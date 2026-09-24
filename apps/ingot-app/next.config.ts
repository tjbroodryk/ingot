import type { NextConfig } from 'next';

/** Next config for the `apps/ingot` public site: a static export built as either a landing or dashboard site. */

/** Whether this is a landing build. */
const LANDING = process.env.NEXT_PUBLIC_INGOT_MODE === 'landing';

/**
 * Registers each mode's page extension, so `page.landing.tsx` is a route only
 * in a landing build and `page.dashboard.tsx` only in a dashboard build.
 */
const pageExtensions = [LANDING ? 'landing.tsx' : 'dashboard.tsx', 'tsx'];

const config: NextConfig = {
  // Don't let Next generate its own agent rule files.
  agentRules: false,
  output: 'export',
  // Serve `/docs/index.html` for both `/docs` and `/docs/` on a static host.
  trailingSlash: true,
  images: { unoptimized: true },
  typedRoutes: true,
  pageExtensions,
  /** Subdirectory prefix when the site is served from one; empty otherwise. */
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
};

export default config;
