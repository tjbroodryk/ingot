import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavGroup } from '../chrome/nav-group';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { DOCS_HREF, REPO_URL } from '../site/mode';
import {
  BRING_IT_UP_LEDE,
  DEPLOYMENT_DESCRIPTION,
  DEPLOYMENT_LEDE,
  type Dependency,
  NOT_NEEDED,
  OPTIONAL,
  REQUIRED,
  SUMMARY,
} from './dependencies';
import { RunTargetRow } from './run-target';
import { RUN_TARGETS } from './targets';

export const deploymentMetadata: Metadata = {
  title: 'Deployment',
  description: DEPLOYMENT_DESCRIPTION,
};

/**
 * The deployment page: how to run Ingot, then the two dependencies every way
 * needs, then the list of things you do not have to provision. A server
 * component rendered at build time.
 */
export function DeploymentPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Deployment}
        actions={
          <>
            <a className="btn-solid" href={REPO_URL}>
              Get the source
            </a>
            <a className="btn-outline" href={DOCS_HREF}>
              API docs
            </a>
          </>
        }
      />

      <div className="docframe">
        <DeploymentNav />

        <main className="docmain">
          <section className="pagehead" id="top">
            <span className="label label-sm kicker">[ Deployment ]</span>
            <h1 className="display">
              Three places, <span className="mark">two dependencies</span>
            </h1>
            <p className="lede">
              <Prose text={DEPLOYMENT_LEDE} />
            </p>
          </section>

          <section className="basics">
            {SUMMARY.map((cell) => (
              <div className="cell" key={cell.title}>
                <span className="cell-kicker">{cell.kicker.toUpperCase()}</span>
                <h4>{cell.title}</h4>
                <p>
                  <Prose text={cell.body} />
                </p>
                <CodeBlock code={cell.sample} />
              </div>
            ))}
          </section>

          {/* The three ways, before the two things they all point at. */}
          <section className="section" id="bring-it-up">
            <span className="label section-kicker">[ Bring it up ]</span>
            <h2 className="deps-heading">Pick a place</h2>
            <p className="deps-para">
              <Prose text={BRING_IT_UP_LEDE} />
            </p>

            <div className="targets">
              {RUN_TARGETS.map((target, index) => (
                <RunTargetRow index={index} key={target.id} target={target} />
              ))}
            </div>
          </section>

          {[...REQUIRED, ...OPTIONAL].map((dependency) => (
            <DependencySection dependency={dependency} key={dependency.id} />
          ))}

          <section className="section" id="nothing-else">
            <span className="label section-kicker">[ What you do not run ]</span>
            <h2 className="deps-heading">The rest of the list</h2>
            <table className="table">
              <thead>
                <tr>
                  <th className="deps-absence-col">Not a dependency</th>
                  <th>What stands in for it</th>
                </tr>
              </thead>
              <tbody>
                {NOT_NEEDED.map((absence) => (
                  <tr key={absence.title}>
                    <td>{absence.title}</td>
                    <td className="prose">
                      <Prose text={absence.body} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="cta">
            <span className="label label-sm kicker">[ The quickest of the three ]</span>
            <h2>Bring one up before you believe any of this</h2>
            <p>
              The compose file is the same one the test suite runs against, so what comes up on your
              machine is what the assertions are made about. That holds whichever of the three you
              end up deploying.
            </p>
            <div className="cta-actions">
              <a className="cta-primary" href="#run-local">
                Run it locally
              </a>
              <code className="cta-curl">bun run db:up &amp;&amp; bun run dev</code>
            </div>
          </section>
        </main>
      </div>

      <SiteFooter>
        <a href="#nothing-else">Not needed</a>
        <a href="#top">Top</a>
      </SiteFooter>
    </>
  );
}

/** One dependency: the argument, then the sample, then the variables. */
function DependencySection({ dependency }: { dependency: Dependency }): ReactNode {
  return (
    <section className="section" id={dependency.id}>
      <span className="label section-kicker">[ {dependency.kicker} ]</span>
      <h2 className="deps-heading">{dependency.title}</h2>

      {dependency.body.map((paragraph) => (
        <p className="deps-para" key={paragraph.slice(0, 48)}>
          <Prose text={paragraph} />
        </p>
      ))}

      {dependency.sample ? <CodeBlock className="deps-sample" code={dependency.sample} /> : null}

      {dependency.settings ? (
        <table className="table deps-settings">
          <thead>
            <tr>
              <th className="deps-name-col">Variable</th>
              <th className="deps-default-col">Default</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {dependency.settings.map((setting) => (
              <tr key={setting.name}>
                <td className="deps-name">{setting.name}</td>
                {/* No fallback is marked rather than left blank: it is what makes the service refuse to start. */}
                <td className="deps-default">
                  {setting.fallback ?? <span className="deps-required">none</span>}
                </td>
                <td className="prose">
                  <Prose text={setting.note} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** Derived from the same lists the page renders. */
function DeploymentNav(): ReactNode {
  return (
    <aside className="docnav">
      <NavGroup label="Ways to run it">
        {RUN_TARGETS.map((target) => (
          <a className="navlink" href={`#${target.id}`} key={target.id}>
            {target.nav}
          </a>
        ))}
      </NavGroup>

      <NavGroup label="Required">
        {REQUIRED.map((dependency) => (
          <a className="navlink" href={`#${dependency.id}`} key={dependency.id}>
            {dependency.nav}
          </a>
        ))}
      </NavGroup>

      <NavGroup label="Optional">
        {OPTIONAL.map((dependency) => (
          <a className="navlink" href={`#${dependency.id}`} key={dependency.id}>
            {dependency.nav}
          </a>
        ))}
      </NavGroup>

      <NavGroup label="Not needed">
        <a className="navlink" href="#nothing-else">
          The rest of the list
        </a>
        <span className="muted">{NOT_NEEDED.length} things you do not run</span>
      </NavGroup>
    </aside>
  );
}
