'use client';

import '@cotera/griddle/style.css';
import '@cotera/griddle/themes/light.css';
import './dashboard.css';

import { SiteFooter } from '../../chrome/site-footer';
import { SiteHeader, SiteSection } from '../../chrome/site-header';
import { QueryConsole } from '../../dashboard/query-console';
import { SignIn } from '../../dashboard/sign-in';
import { useSession } from '../../dashboard/session';
import { DOCS_HREF } from '../../site/mode';

/**
 * The dashboard, which is the gate and one console behind it.
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
 * Griddle's stylesheets are imported here, at the boundary, because they are
 * global CSS and that is where global CSS is allowed to enter.
 */
export default function DashboardPage() {
  const { session, ready, signIn, signOut } = useSession();

  return (
    <>
      <SiteHeader
        current={SiteSection.Dashboard}
        actions={
          <a className="btn-outline" href={DOCS_HREF}>
            Read the docs
          </a>
        }
      />

      <div className="dashframe">
        {/*
          Nothing is rendered until storage has been read. The alternative is
          showing the sign-in form for one frame to somebody who is already
          signed in, which is a flash of the wrong screen on every reload.
        */}
        {!ready ? null : session ? (
          <>
            <div className="dashhead">
              <div>
                <span className="label label-sm kicker">[ Signed in ]</span>
                <h1 className="dashtitle">{session.account}</h1>
              </div>
              <button className="btn-outline" onClick={signOut} type="button">
                Sign out
              </button>
            </div>

            <QueryConsole credentials={session} onCredentialsRejected={signOut} />
          </>
        ) : (
          <SignIn onSignedIn={signIn} />
        )}
      </div>

      <SiteFooter />
    </>
  );
}
