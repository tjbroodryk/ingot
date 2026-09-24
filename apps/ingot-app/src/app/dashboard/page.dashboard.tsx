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
 * The dashboard: the gate and one console behind it. `'use client'` here marks
 * the boundary, so everything it imports is a client component. Statically
 * exported; the key never leaves the browser.
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
        {/* Render nothing until storage is read, so the sign-in form does not flash for a signed-in user. */}
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
