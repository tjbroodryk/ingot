import type { ReactNode } from 'react';
import { NavGroup } from '../chrome/nav-group';
import { DASHBOARD_HREF } from '../site/mode';
import { ENDPOINTS, GROUPS, GROUP_ORDER, endpointsIn } from './reference';

/** The sidebar, derived from the same `ENDPOINTS` list the page renders. */
export function DocsNav(): ReactNode {
  return (
    <aside className="docnav">
      <NavGroup label="Start here">
        <a className="navlink" href="#base">
          Base URL
        </a>
        <a className="navlink" href="#auth">
          Authentication
        </a>
        <a className="navlink" href="#quickstart">
          Quickstart
        </a>
        <a className="navlink" href="#errors">
          Status codes
        </a>
      </NavGroup>

      {GROUP_ORDER.map((group) => (
        <NavGroup key={group} label={GROUPS[group].nav}>
          {endpointsIn(group).map((endpoint) => (
            <a className="navlink" href={`#${endpoint.id}`} key={endpoint.id}>
              {endpoint.nav}
            </a>
          ))}
        </NavGroup>
      ))}

      {/* No console group in a landing build; the route count moves up so the sidebar does not end on a bare rule. */}
      {DASHBOARD_HREF ? (
        <NavGroup label="Console">
          <a className="navlink" href={DASHBOARD_HREF}>
            Run a query
          </a>
          <span className="muted">{ENDPOINTS.length} routes in all</span>
        </NavGroup>
      ) : (
        <span className="muted">{ENDPOINTS.length} routes in all</span>
      )}
    </aside>
  );
}
