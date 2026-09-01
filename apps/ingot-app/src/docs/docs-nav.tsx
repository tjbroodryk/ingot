import type { ReactNode } from 'react';
import { NavGroup } from '../chrome/nav-group';
import { DASHBOARD_HREF } from '../site/mode';
import { ENDPOINTS, GROUPS, GROUP_ORDER, endpointsIn } from './reference';

/**
 * The sidebar, derived from the same list the page renders.
 *
 * Not a second copy: an endpoint added to `ENDPOINTS` appears here, and one
 * removed leaves no dead anchor behind. That is the whole reason the reference
 * is data rather than markup.
 */
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

      {/*
        The console is a route a landing build does not have, so the group that
        links it is not rendered there — and the route count, which is the only
        other thing in it, moves up to keep the sidebar from ending on a rule
        with nothing under it.
      */}
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
