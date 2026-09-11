'use client';

import '@cotera/griddle/style.css';
import './dashboard.css';

import { SiteFooter } from '../../chrome/site-footer';
import { SiteHeader, SiteSection } from '../../chrome/site-header';
import { INGOT_HOST } from '../../dashboard/ingot-api';
import { useSession } from '../../dashboard/session';
import { SignIn } from '../../dashboard/sign-in';
import { Workbench } from '../../dashboard/workbench';
import { DOCS_HREF } from '../../site/mode';

/**
 * The dashboard, which is the gate and one workbench behind it.
 *
 * `'use client'` on the page rather than on each part below it: this is the
 * boundary, and everything it imports is a client component by consequence.
 * Marking the leaves instead would make each of them a separate entry, and a
 * component taking a callback prop across an entry boundary is an error rather
 * than a warning.
 *
 * The page is still statically exported. Nothing here runs on a server —
 * there is no server — and the key never leaves the browser it was typed into:
 * every request goes straight from the tab to the Ingot API.
 *
 * Griddle's stylesheet is imported here, at the boundary, because it is global
 * CSS and that is where global CSS is allowed to enter. Its stock themes are
 * not: `dashboard.css` sets all nine of Griddle's tokens from ours, and a
 * second palette would only be something for those to win against.
 */
export default function DashboardPage() {
  const { session, ready, signIn, signOut } = useSession();

  return (
    <>
      <SiteHeader
        current={SiteSection.Dashboard}
        actions={
          !ready ? null : session ? (
            <>
              <span className="dash-account">{session.account}</span>
              <button className="btn-outline" onClick={signOut} type="button">
                Sign out
              </button>
            </>
          ) : (
            <a className="btn-outline" href={DOCS_HREF}>
              Read the docs
            </a>
          )
        }
      />

      {/*
        Nothing is rendered until storage has been read. The alternative is
        showing the gate for one frame to somebody who is already signed in,
        which is a flash of the wrong screen on every reload.

        Keyed on the account, so signing in as somebody else starts a fresh
        workbench rather than carrying the last account's activity into it.
      */}
      {!ready ? (
        <div className="dash-pending" />
      ) : session ? (
        <Workbench
          key={session.account}
          credentials={session}
          onCredentialsRejected={signOut}
        />
      ) : (
        <SignIn onSignedIn={signIn} />
      )}

      <SiteFooter>
        <span className="dash-host">{INGOT_HOST}</span>
      </SiteFooter>
    </>
  );
}
