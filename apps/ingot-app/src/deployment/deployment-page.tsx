import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavGroup } from '../chrome/nav-group';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { DOCS_HREF, REPO_URL } from '../site/mode';
import { type Dependency, NOT_NEEDED, OPTIONAL, REQUIRED, SUMMARY } from './dependencies';
import { RunTargetRow } from './run-target';
import { RUN_TARGETS } from './targets';

export const deploymentMetadata: Metadata = {
  title: 'Deployment',
  description:
    'How to run Ingot — on your machine, as a container, on Kubernetes — and the infrastructure all three need: a Postgres, somewhere to put Parquet, and an argument for why there is nothing else on the list.',
};

/**
 * The deployment page.
 *
 * The reference answers what Ingot serves; this answers how to have one at all,
 * which is the question a self-hosted-only project owes an answer to before
 * anybody clones it. Two halves, in the order somebody needs them: the ways to
 * bring one up, then the two things every one of those ways is pointing at,
 * then the list of things somebody would reasonably expect to provision and
 * does not have to. That third list is the one usually missing from a page
 * like this, and it is the one that decides whether the first two are
 * believable.
 *
 * The rows in the first half are the landing page's, from the same
 * `targets.ts` and through the same `RunTargetRow` — this is where they are
 * load-bearing rather than persuasive, so what changes is what sits under
 * them, not the rows.
 *
 * Built from data rather than written as markup, so the sidebar and the
 * sections cannot come apart. A server component with no fetching: it renders
 * once, at build time, into static HTML.
 */
export function DeploymentPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Deployment}
        anchors={[
          { href: '#bring-it-up', label: 'Bring it up' },
          { href: '#nothing-else', label: 'Not needed' },
        ]}
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
              <Prose
                text={
                  'Ingot is one process that needs a Postgres and somewhere to put Parquet, ' +
                  'and every way of running it below is those two in a different dialect. ' +
                  'Everything under them is a choice you are allowed to decline, and the ' +
                  'things that are not on the list at all — a broker, a scheduler, a vector ' +
                  'database — are missing on purpose rather than by omission.'
                }
              />
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

          {/*
            The three ways, before the two things they all point at.

            This order is the argument the page is making: a reader who came
            here to deploy wants the commands, and the dependency sections
            below are what each of those commands was already assuming. The
            other order — provisioning first, running last — is the one that
            reads like a bill.
          */}
          <section className="section" id="bring-it-up">
            <span className="label section-kicker">[ Bring it up ]</span>
            <h2 className="deps-heading">Pick a place</h2>
            <p className="deps-para">
              <Prose
                text={
                  'Each of these answers the same four questions in the same order — what ' +
                  'you need, what to run, how you know it worked, and the one thing that ' +
                  'catches people. What they need is the two sections after them.'
                }
              />
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

          {/*
            The local one, named as the local one. It closes a page about three
            targets by recommending a fourth thing — checking the page — and
            the machine in front of you is the only one of the three you can do
            that on in a minute.
          */}
          <section className="cta">
            <span className="label label-sm kicker">[ The quickest of the three ]</span>
            <h2>Bring one up before you believe any of this</h2>
            <p>
              The compose file is the same one the test suite runs against, so what comes up on your
              machine is what the assertions are made about — whichever of the three you end up
              deploying.
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
                {/*
                  A variable with nothing to fall back to is the interesting
                  case on this page — it is the difference between a service
                  that starts with a default you did not choose and one that
                  refuses — so it is marked rather than left blank.
                */}
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

/** Derived from the same lists the page renders, for the reason `DocsNav` is. */
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
