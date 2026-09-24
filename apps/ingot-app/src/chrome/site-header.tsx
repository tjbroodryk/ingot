import type { ReactNode } from 'react';
import {
  BENCHMARKS_HREF,
  DASHBOARD_HREF,
  DEPLOYMENT_HREF,
  DOCS_HREF,
  HOME_HREF,
  WHY_HREF,
} from '../site/mode';
import { BrandMark } from './brand-mark';

/** Which nav item is the page you are on. */
export enum SiteSection {
  Landing = 'landing',
  Docs = 'docs',
  Dashboard = 'dashboard',
  Why = 'why',
  Deployment = 'deployment',
  Benchmarks = 'benchmarks',
}

/** The bar across the top of every page. Offers the build's route list only; a route that is `null` is omitted. */
export function SiteHeader({
  current,
  actions,
}: {
  current: SiteSection;
  /** The buttons at the right-hand end, supplied by the caller. */
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="topbar label">
      <nav className="topbar-nav">
        {WHY_HREF ? (
          <a href={WHY_HREF} aria-current={current === SiteSection.Why ? 'page' : undefined}>
            Why
          </a>
        ) : null}
        {BENCHMARKS_HREF ? (
          <a
            href={BENCHMARKS_HREF}
            aria-current={current === SiteSection.Benchmarks ? 'page' : undefined}
          >
            Benchmarks
          </a>
        ) : null}
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
