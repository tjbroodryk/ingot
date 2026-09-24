import type { Metadata } from 'next';
import { Fragment } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { DASHBOARD_HREF, IS_LANDING, REPO_URL } from '../site/mode';
import { CodeBlock } from './code-block';
import { DocsNav } from './docs-nav';
import { EndpointRow } from './endpoint-row';
import {
  BASICS,
  QUICKSTART,
  REFERENCE_DESCRIPTION,
  REFERENCE_LEDE,
  REFERENCE_TITLE,
  STATUS_CODES,
} from './page-sections';
import { Prose } from './prose';
import { ENDPOINTS, GROUPS, GROUP_ORDER, endpointsIn } from './reference';

export const referenceMetadata: Metadata = {
  title: REFERENCE_TITLE,
  description: REFERENCE_DESCRIPTION,
};

/** The reference. A component, not a page: the front page of a dashboard build and `/docs` of a landing one. Rendered at build time. */
export function ReferencePage() {
  return (
    <>
      <SiteHeader
        current={SiteSection.Docs}
        actions={
          <>
            {/* A landing build points at the repository; a dashboard build at the sign-up section. */}
            {IS_LANDING ? (
              <a className="btn-solid" href={REPO_URL}>
                Get the source
              </a>
            ) : (
              <a className="btn-solid" href="#account-create">
                Get a key
              </a>
            )}
            {DASHBOARD_HREF ? (
              <a className="btn-outline" href={DASHBOARD_HREF}>
                Dashboard
              </a>
            ) : null}
          </>
        }
      />

      <div className="docframe">
        <DocsNav />

        <main className="docmain">
          <section className="pagehead">
            <span className="label label-sm kicker">[ API reference · v1 ]</span>
            <h1 className="display">
              The <span className="mark">Ingot</span> HTTP API
            </h1>
            <p className="lede">
              <Prose text={REFERENCE_LEDE} />
            </p>
          </section>

          <section className="basics">
            {BASICS.map((basic) => (
              <div className="cell" id={basic.id} key={basic.kicker}>
                <span className="cell-kicker">{basic.kicker.toUpperCase()}</span>
                <h4>{basic.title}</h4>
                <p>
                  <Prose text={basic.body} />
                </p>
                <CodeBlock code={basic.sample} />
              </div>
            ))}
          </section>

          <section className="section" id="quickstart">
            <span className="label section-kicker">[ Quickstart ]</span>
            <div className="panel">
              <div className="panel-bar">
                <span className="panel-glyph">≡ ×</span>
                <span className="panel-rule" />
                <span>Three calls</span>
                <span className="panel-rule" />
              </div>
              <CodeBlock code={QUICKSTART} />
            </div>
          </section>

          <section className="section" id="errors">
            <span className="label section-kicker">[ Status codes ]</span>
            <table className="table table-mono">
              <thead>
                <tr>
                  <th className="code-col">Code</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {STATUS_CODES.map((status) => (
                  <tr key={status.code}>
                    <td>{status.code}</td>
                    <td>
                      <Prose text={status.when} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="reference-head" id="reference">
            <span className="label label-sm kicker">[ Reference ]</span>
            <h2>Endpoints</h2>
          </div>

          {/* Fragments, not wrappers: a div would break the `.reference-head + .grouphead` adjacency rule. */}
          {GROUP_ORDER.map((group) => {
            const endpoints = endpointsIn(group);
            return (
              <Fragment key={group}>
                <div className="grouphead">
                  <span>[ {GROUPS[group].title} ]</span>
                  <span className="muted">
                    {endpoints.length} {endpoints.length === 1 ? 'route' : 'routes'}
                  </span>
                </div>
                {endpoints.map((endpoint) => (
                  <EndpointRow endpoint={endpoint} key={endpoint.id} />
                ))}
              </Fragment>
            );
          })}

          <section className="cta">
            <span className="label label-sm kicker">[ Get started ]</span>
            <h2>{ENDPOINTS.length} routes is the whole surface</h2>
            <p>Sign up, mint a key, cast a memory. The secret comes back exactly once.</p>
            <div className="cta-actions">
              <a className="cta-primary" href="#quickstart">
                Read the quickstart
              </a>
              <code className="cta-curl">curl -X POST http://localhost:3002/api/v1/accounts</code>
            </div>
          </section>
        </main>
      </div>

      <SiteFooter>
        <a href="#reference">Reference</a>
        <a href="#base">Top</a>
      </SiteFooter>
    </>
  );
}
