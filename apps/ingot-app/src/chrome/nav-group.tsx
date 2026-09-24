import type { ReactNode } from 'react';

/** A labelled run of links in a sidebar. */
export function NavGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="navgroup">
      <div className="label label-sm navgroup-label">[ {label} ]</div>
      {children}
    </div>
  );
}
