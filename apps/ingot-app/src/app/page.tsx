import type { Metadata } from 'next';
import { Fragment } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { DocsNav } from '../docs/docs-nav';
import { EndpointRow } from '../docs/endpoint-row';
import { BASICS, QUICKSTART, STATUS_CODES } from '../docs/page-sections';
import { Prose } from '../docs/prose';
import { ENDPOINTS, GROUPS, GROUP_ORDER, endpointsIn } from '../docs/reference';

export const metadata: Metadata = {
  title: 'The Ingot HTTP API',
  description:
    'Every route Ingot serves, with its authentication, its request body and the shape it answers with.',
};

/**
 * The reference, and for now the whole site.
 *
 * A server component with no data fetching in it: the content is a module, so
 * this renders once at build time into static HTML. The one interactive thing
 * on the page — the sidebar — is an anchor list, which needs no JavaScript at
 * all.
 */
export default function DocsPage() {
  return (
    <>
      <SiteHeader
        current={SiteSection.Docs}
        anchors={[
          { href: '#reference', label: 'Reference' },
          { href: '#mcp-account', label: 'MCP' },
        ]}
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
              <Prose
                text={`${ENDPOINTS.length} routes. One bearer key. Everything sits under \`/api/v1\` except the two version-neutral service routes, so a load balancer never has to be updated when the contract is.`}
              />
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

          {/*
            Fragments rather than wrappers: the group head's rule is drawn by
            `.reference-head + .grouphead`, and a div between them would break
            the adjacency and leave a double rule under the title.
          */}
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
              <code className="cta-curl">curl -X POST https://api.ingot.dev/api/v1/accounts</code>
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
