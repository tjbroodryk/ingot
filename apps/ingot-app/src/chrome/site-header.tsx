import type { ReactNode } from 'react';
import { DASHBOARD_HREF, DEPLOYMENT_HREF, DOCS_HREF, HOME_HREF } from '../site/mode';
import { BrandMark } from './brand-mark';

/** Which nav item is the page you are on. */
export enum SiteSection {
  Landing = 'landing',
  Docs = 'docs',
  Dashboard = 'dashboard',
  Deployment = 'deployment',
}

/**
 * The bar across the top of every page.
 *
 * What it offers is the build's route list and nothing more. A landing build
 * has no console, so there is no console link to grey out or hide — the value
 * that would name it is `null`, which is what `src/site/mode.ts` hands back
 * when `next.config.ts` has dropped the route. A header that points at a page
 * which does not exist is worse than one that does not mention it.
 *
 * The links are anchors rather than `<Link>` because their targets move
 * between builds; `mode.ts` carries the reasoning.
 */
export function SiteHeader({
  current,
  anchors = [],
  actions,
}: {
  current: SiteSection;
  /** In-page jumps, for a page long enough to want them. */
  anchors?: readonly { href: string; label: string }[];
  /**
   * The buttons at the right-hand end, which are the caller's for the same
   * reason the footer's links are: "Get a key" is an anchor on the reference
   * and is nothing anywhere else, and a header that picked one for you would
   * sooner or later offer a jump to a section the page does not have.
   */
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="topbar label">
      <nav className="topbar-nav">
        <a href={DOCS_HREF} aria-current={current === SiteSection.Docs ? 'page' : undefined}>
          Docs
        </a>
        {DASHBOARD_HREF ? (
          <a
            href={DASHBOARD_HREF}
            aria-current={current === SiteSection.Dashboard ? 'page' : undefined}
          >
            Dashboard
          </a>
        ) : null}
        {DEPLOYMENT_HREF ? (
          <a
            href={DEPLOYMENT_HREF}
            aria-current={current === SiteSection.Deployment ? 'page' : undefined}
          >
            Deployment
          </a>
        ) : null}
        {anchors.map((anchor) => (
          <a href={anchor.href} key={anchor.href}>
            {anchor.label}
          </a>
        ))}
      </nav>

      <a className="brand" href={HOME_HREF}>
        <BrandMark className="brand-mark" />
        <span className="brand-word">Ingot</span>
      </a>

      <div className="topbar-meta">
        <span className="muted">API v1</span>
        <span className="topbar-divider" />
        {actions}
      </div>
    </header>
  );
}
