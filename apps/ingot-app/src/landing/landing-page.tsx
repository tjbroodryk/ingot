import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { ELSEWHERE, RUN_TARGETS } from '../deployment/targets';
import { RunTargetRow } from '../deployment/run-target';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { SampleTone } from '../docs/reference';
import { DEPLOYMENT_HREF, DOCS_HREF, REPO_URL } from '../site/mode';
import './landing.css';
import {
  FEATURES,
  MCP_CONFIG,
  MCP_TOOLS,
  RECALL,
  REMEMBER,
  SPEAKS,
  STEPS,
  TWO_WAYS,
} from './sections';

/**
 * The page in front of the project, and only in a landing build — see
 * `src/site/mode.ts`.
 *
 * Drawn from the Modernist artboard the rest of the site was, with the one
 * change the artboard could not know about: Ingot is self-hosted, so every
 * place the design sold a hosted service — the sign-up buttons, the pricing
 * link, the "start for free" — is either gone or points at the repository.
 * That is said three times on the way down the page, at the top, in the hero's
 * own call to action, and in the band that replaces the sign-up CTA, because a
 * reader who finds out on the third scroll has already been misled twice.
 *
 * A server component with nothing to fetch: it renders once, at build time.
 */
export function LandingPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Landing}
        anchors={[
          // No `#run` here: the header carries Deployment on every page of a
          // landing build, and on this one it is already the jump this would
          // be. Two nav items pointing at one section is one of them wearing
          // out.
          { href: '#how', label: 'How it works' },
          { href: '#mcp', label: 'MCP' },
        ]}
        actions={
          <a className="btn-solid" href={REPO_URL}>
            Get the source
          </a>
        }
      />

      <div className="landframe">
        <section className="hero">
          <div className="hero-badge label">
            <span className="badge">Self-hosted</span>
            <a href="#run">There is no hosted Ingot — you run it</a>
          </div>

          <h1 className="hero-title">
            Memory your
            <br />
            <span className="mark">model can query</span>
          </h1>

          <p className="hero-lede">
            Durable, typed memory for LLM agents. Store a tool result, read it back as SQL or search
            — no vector plumbing, no re-reading transcripts.
          </p>

          <div className="hero-actions label">
            <a className="btn-solid btn-lg" href="#run-local">
              Run it locally
            </a>
            <a className="btn-outline btn-lg" href={DOCS_HREF}>
              View docs
            </a>
          </div>

          <div className="label label-sm speaks-label">Speaks</div>
          <div className="speaks">
            {SPEAKS.map((thing) => (
              <span key={thing}>{thing}</span>
            ))}
          </div>
        </section>

        {/*
          The two calls that are the whole product, side by side, because the
          claim the page is making is about the second following the first
          immediately rather than about either on its own.
        */}
        <section className="landsection">
          <div className="panel panel-wide">
            <div className="panel-bar">
              <span className="panel-glyph">≡ ×</span>
              <span className="panel-rule" />
              <span>Ingot · crm-notes</span>
              <span className="panel-rule" />
            </div>
            <div className="panel-split">
              <CodeBlock code={REMEMBER} />
              <CodeBlock code={RECALL} />
            </div>
          </div>
        </section>

        <section className="landblock" id="how">
          <div className="landhead">
            <span className="label label-sm kicker">[ How it works ]</span>
            <h2 className="landtitle">
              <span className="mark">Cast it</span>, fill it,
              <br />
              read it back
            </h2>
            <p>
              Three calls is the whole loop. Everything else — keys, retention, schema, MCP — hangs
              off the same bearer token.
            </p>
          </div>

          <div className="steps">
            {STEPS.map((step) => (
              <div className="step" key={step.n}>
                <div className="step-num">{step.n}</div>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
                <code>{step.route}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="landblock">
          <div className="landhead landhead-tight">
            <span className="label label-sm kicker">[ What you get ]</span>
            <h2 className="landtitle">
              Everything an agent
              <br />
              needs to remember
            </h2>
          </div>

          <div className="label features-note">&gt; Included (↓↓)</div>

          <div className="features">
            {FEATURES.map((feature) => (
              <div className="feature" key={feature.kicker}>
                <div className="feature-kicker">{feature.kicker.toUpperCase()}</div>
                <h4>{feature.title}</h4>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="split" id="read">
          <div className="split-copy">
            <span className="label label-sm kicker">[ Two ways to read ]</span>
            <h3>SQL when it knows the shape. Words when it doesn&rsquo;t.</h3>
            <p>
              The same endpoint takes either, and given both it binds the embedding as{' '}
              <code>$q</code> so a hybrid search is one round trip. A POST that changes nothing,
              hence the explicit 200.
            </p>
            <div className="chips">
              <span className="chip chip-accent">one SELECT</span>
              <span className="chip">FTS stemmer</span>
              <span className="chip">stopwords</span>
              <span className="chip">semantic</span>
            </div>
          </div>
          <div className="split-figure">
            <CodeBlock code={TWO_WAYS} />
          </div>
        </section>

        <section className="split" id="mcp">
          <div className="split-figure">
            <CodeBlock code={MCP_CONFIG} tone={SampleTone.Ink} />
          </div>
          <div className="split-copy">
            <span className="label label-sm kicker">[ MCP native ]</span>
            <h3>
              Same key.
              <br />
              No second auth path.
            </h3>
            <p>
              MCP over streamable HTTP, stateless, behind the same bearer key and the same guards.
              The schema is handed over as the server&rsquo;s instructions at{' '}
              <code>initialize</code> — so writing SQL costs no tool call.
            </p>
            <div className="tools">
              {MCP_TOOLS.map((row) => (
                <div className="tool" key={row.scope}>
                  <span className="tool-scope">{row.scope}</span>
                  <span>{row.tools}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/*
          Where you can run it, one row per place.

          This is the section that grows, so nothing about it is written twice:
          the rows come from `targets.ts` and the numbering comes from their
          position, which is what keeps a fourth target from being an edit in
          four files. The four labelled slots repeat down the section on
          purpose — that repetition is what lets somebody compare two ways of
          running this without reading either in full.
        */}
        <section className="landblock" id="run">
          <div className="landhead">
            <span className="label label-sm kicker">[ Ways to run it ]</span>
            {/*
              The highlight gets its own line rather than being left to wrap
              into one: `.mark` is a painted box, and a box broken across two
              lines is two boxes with a ragged edge between them.
            */}
            <h2 className="landtitle">
              Pick a place.
              <br />
              The steps are
              <br />
              <span className="mark">the same shape</span>
            </h2>
            <p>
              Every target below answers the same four questions in the same order — what you need,
              what to run, how you know it worked, and the one thing that catches people. There is
              no fifth question, and none of them is left out.
            </p>

            {/*
              The jumps are derived rather than written down, so a target added
              to the list is a target this row can reach. They double as the
              section's own table of contents: the rows are long, and the one
              somebody wants is usually decided before they start reading.
            */}
            <div className="chips target-jumps">
              {RUN_TARGETS.map((target) => (
                <a className="chip" href={`#${target.id}`} key={target.id}>
                  {target.nav}
                </a>
              ))}
            </div>

            {/*
              Where the same three rows are, with the two dependencies they
              all share written out underneath them. Guarded because the route
              is `null` in a dashboard build — which is a build this page is
              never in, and a thing the type cannot know.
            */}
            {DEPLOYMENT_HREF ? (
              <a className="target-more landhead-more" href={DEPLOYMENT_HREF}>
                The same three, with the dependencies underneath →
              </a>
            ) : null}
          </div>

          <div className="targets">
            {RUN_TARGETS.map((target, index) => (
              <RunTargetRow index={index} key={target.id} target={target} />
            ))}

            <div className="elsewhere" id="run-elsewhere">
              <div className="elsewhere-copy">
                <div className="target-num">{ELSEWHERE.kicker}</div>
                <h4>{ELSEWHERE.title}</h4>
                <p>
                  <Prose text={ELSEWHERE.body} />
                </p>
              </div>
              <a className="btn-outline label" href={ELSEWHERE.cta.href}>
                {ELSEWHERE.cta.label}
              </a>
            </div>
          </div>
        </section>

        {/*
          Where the design put "Sign up. The secret is shown once." There is
          nothing to sign up to, so this is the same band saying the true
          version: the sign-up route is real, and it is on the instance you
          brought up yourself. The commands that used to sit here are the local
          target's now, so that the bring-up is written down once.
        */}
        <section className="cta cta-centred">
          <span className="label label-sm kicker">[ Self-hosted, for now ]</span>
          <h2>Bring it up. Sign up against your own address.</h2>
          <p>
            There is no hosted Ingot yet. It is a NestJS service, a Postgres and a bucket — and
            however you choose to run those three, sign-up is the same open POST, and the secret
            still comes back exactly once.
          </p>

          <div className="cta-actions">
            <a className="cta-primary" href={REPO_URL}>
              Get the source
            </a>
            <a className="btn-outline btn-lg cta-secondary" href={DOCS_HREF}>
              Read the API docs
            </a>
          </div>
        </section>
      </div>

      <SiteFooter>
        <a href={DOCS_HREF}>API reference</a>
        <a href={REPO_URL}>GitHub</a>
      </SiteFooter>
    </>
  );
}
