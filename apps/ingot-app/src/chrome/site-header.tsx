import Link from 'next/link';
import type { ReactNode } from 'react';

/** Which nav item is the page you are on. */
export enum SiteSection {
  Docs = 'docs',
  Dashboard = 'dashboard',
}

/**
 * The bar across the top of every page.
 *
 * Deliberately short of the design's nav: the landing page is not built yet,
 * so "Product" is not a link here. A header that points at a page which does
 * not exist is worse than one that does not mention it.
 */
export function SiteHeader({
  current,
  anchors = [],
}: {
  current: SiteSection;
  /** In-page jumps, for a page long enough to want them. */
  anchors?: readonly { href: string; label: string }[];
}): ReactNode {
  return (
    <header className="topbar label">
      <nav className="topbar-nav">
        <Link href="/" aria-current={current === SiteSection.Docs ? 'page' : undefined}>
          Docs
        </Link>
        <Link
          href="/dashboard"
          aria-current={current === SiteSection.Dashboard ? 'page' : undefined}
        >
          Dashboard
        </Link>
        {anchors.map((anchor) => (
          <a href={anchor.href} key={anchor.href}>
            {anchor.label}
          </a>
        ))}
      </nav>

      <Link className="brand" href="/">
        <span className="brand-mark" />
        <span className="brand-word">Ingot</span>
      </Link>

      <div className="topbar-meta">
        <span className="muted">API v1</span>
        <span className="topbar-divider" />
        {current === SiteSection.Dashboard ? (
          <Link className="btn-outline" href="/">
            Read the docs
          </Link>
        ) : (
          <>
            <a className="btn-solid" href="#account-create">
              Get a key
            </a>
            <Link className="btn-outline" href="/dashboard">
              Dashboard
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
