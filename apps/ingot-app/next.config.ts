import type { NextConfig } from 'next';

/**
 * The public site for `apps/ingot` — the API reference, and eventually the
 * landing page in front of it.
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
};

export default config;
