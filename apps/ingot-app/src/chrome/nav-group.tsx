import type { ReactNode } from 'react';

/**
 * A labelled run of links in a sidebar.
 *
 * Shared by the two sidebars the site has rather than written twice, because
 * the bracketed label is a piece of the design and not a piece of either page:
 * the reference and the self-hosting page should not be able to disagree about
 * what a group heading looks like.
 */
export function NavGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="navgroup">
      <div className="label label-sm navgroup-label">[ {label} ]</div>
      {children}
    </div>
  );
}
