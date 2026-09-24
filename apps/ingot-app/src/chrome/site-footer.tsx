import type { ReactNode } from 'react';
import { BrandMark } from './brand-mark';

/** The rule at the bottom of the page. Links are supplied by the caller. */
export function SiteFooter({ children }: { children?: ReactNode }): ReactNode {
  return (
    <footer className="sitefoot label">
      <span className="sitefoot-brand">
        <BrandMark className="sitefoot-mark" />
        Ingot · API v1
      </span>
      {children}
    </footer>
  );
}
