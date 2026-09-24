import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { ELSEWHERE, RUN_TARGETS } from '../deployment/targets';
import { RunTargetRow } from '../deployment/run-target';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { SampleTone } from '../docs/reference';
import { DEPLOYMENT_HREF, DOCS_HREF, REPO_URL, WHY_HREF } from '../site/mode';
import './landing.css';
import {
  AI_SDK_SEEN,
  AI_SDK_TOOL,
  FEATURES,
  HARNESS,
  HARNESS_RETURN,
  LEDE,
  MCP_CONFIG,
  MCP_TOOLS,
  RECALL,
  RECEIPTS,
  REMEMBER,
  RETRIEVAL,
  SDK_NOTES,
  SPEAKS,
  STEPS,
} from './sections';

/** The page in front of the project, and only in a landing build. A server component rendered at build time. */
export function LandingPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Landing}
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
            <a href="#run">There is no hosted Ingot yet — you run it</a>
          </div>

          <h1 className="hero-title">
            Memory your
            <br />
            <span className="mark">model can query</span>
          </h1>

          {/* Also `layout.tsx`'s `description` — see the constant. */}
          <p className="hero-lede">{LEDE}</p>

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
              Three calls is the whole loop. That is genuinely it — everything else you might want,
              like keys, retention, schema or MCP, hangs off the same bearer token.
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

        <section className="landblock" id="harness">
          <div className="landhead">
            <span className="label label-sm kicker">[ In the agent loop ]</span>
            <h2 className="landtitle">
              Store the result.
              <br />
              Return
              <br />
              <span className="mark">the receipt</span>
            </h2>
            <p>
              The instinct is that a tool result has to go into the context window to be useful
              later. It doesn&rsquo;t. One POST puts it in the memory, and what comes back is small
              enough to be the tool&rsquo;s own output — carrying the SQL that finds the rows again.
            </p>
            <a className="target-more landhead-more" href="#ai-sdk">
              The same thing as a file you can type ↓
            </a>
          </div>

          <div className="landfigure">
            {/* A panel, not a bare grid, so the loop reads as one figure not four more tiles. */}
            <div className="panel panel-wide">
              <div className="panel-bar">
                <span className="panel-glyph">≡ ×</span>
                <span className="panel-rule" />
                <span>One turn</span>
                <span className="panel-rule" />
              </div>

              <div className="wire-lane">
                {HARNESS.map((node) => (
                  <div className="wire-node" key={node.actor}>
                    <div className="wire-actor">{node.actor}</div>
                    <h4>{node.title}</h4>
                    <p>{node.body}</p>
                    <code>{node.wire}</code>
                  </div>
                ))}
              </div>

              {/* The one hop that runs back — why the loop is drawn as a loop. */}
              <div className="wire-return">{HARNESS_RETURN}</div>
            </div>
          </div>
        </section>

        <section className="landblock" id="ai-sdk">
          <div className="landhead">
            <span className="label label-sm kicker">[ Vercel AI SDK ]</span>
            <h2 className="landtitle">
              It fits inside
              <br />
              <span className="mark">one execute</span>
            </h2>
            <p>
              There is no adapter here, and no middleware. <code>execute</code> already returns
              whatever the model is going to read, so have it return the receipt instead of the rows
              — and the rest of your harness, the stream and the parts and the steps, never finds
              out anything changed.
            </p>
          </div>

          <div className="landfigure">
            <div className="panel panel-wide">
              <div className="panel-bar">
                <span className="panel-glyph">≡ ×</span>
                <span className="panel-rule" />
                <span>Ingot · ai-sdk</span>
                <span className="panel-rule" />
              </div>
              <div className="panel-split">
                <CodeBlock code={AI_SDK_TOOL} />
                <CodeBlock code={AI_SDK_SEEN} />
              </div>
            </div>
          </div>

          {/* `.steps` again: same shape, labelled instead of numbered. */}
          <div className="steps">
            {SDK_NOTES.map((note) => (
              <div className="step" key={note.kicker}>
                <div className="step-num">{note.kicker.toUpperCase()}</div>
                <h4>{note.title}</h4>
                <p>{note.body}</p>
                <code>{note.hint}</code>
              </div>
            ))}
          </div>
        </section>

        {/* Figure first, to keep the splits alternating down the page. */}
        <section className="split" id="receipts">
          <div className="split-figure">
            <CodeBlock code={RECEIPTS} />
          </div>
          <div className="split-copy">
            <span className="label label-sm kicker">[ Receipts &amp; embeddings ]</span>
            <h3>
              Opt in to the
              <br />
              expensive parts.
            </h3>
            <p>
              We split these two on purpose. <code>embed</code> belongs to the table: set it once
              when the column is declared and it applies to every write after that.{' '}
              <code>receipt</code> is per call, because it costs a model call every time. A loop
              storing ten thousand tool results should never end up paying for either by accident.
            </p>
            <p>
              A receipt comes back <code>pending</code>, with the SELECT that will answer it. The
              model writing the summary is a network away; your rows are queryable the instant{' '}
              <code>/add</code> returns. Point the memory at a webhook or a queue and you get told
              instead of having to ask.
            </p>
            <div className="chips">
              <span className="chip chip-accent">embed per column</span>
              <span className="chip">receipt per call</span>
              <span className="chip">webhook</span>
              <span className="chip">rabbitmq</span>
            </div>
          </div>
        </section>

        <section className="split" id="read">
          <div className="split-copy">
            <span className="label label-sm kicker">[ Retrieval, and RAG ]</span>
            <h3>
              RAG retrieval.
              <br />
              No second database.
            </h3>
            <p>
              <code>text</code> on its own embeds the question and ranks a table by cosine
              similarity, so rows come back carrying a <code>score</code>. SQL on its own is exact.
              Send both and the embedding binds as <code>$q</code>, so one SELECT can rank by
              meaning, match BM25 and filter on real columns at the same time.
            </p>
            <p>
              That is normally three pieces of infrastructure: a vector store, a metadata index, and
              a filtering hop between them. We did not want to run any of those, so here it is one
              POST against the memory you were already writing to. Neither half is on by default —
              you declare embeddings per column and the keyword index per table, so a memory holding
              no prose pays for neither.
            </p>
            <div className="chips">
              <span className="chip chip-accent">one SELECT</span>
              <span className="chip">cosine</span>
              <span className="chip">BM25</span>
              <span className="chip">metadata filter</span>
              <span className="chip">no vector db</span>
            </div>
            {/* `/why` covers why this is the shape of the service. Guarded: the route is `null` where absent. */}
            {WHY_HREF ? (
              <a className="target-more" href={WHY_HREF}>
                Why a query engine, and not a vector store →
              </a>
            ) : null}
          </div>
          <div className="split-figure">
            <CodeBlock code={RETRIEVAL} />
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
              <code>initialize</code>, so getting to the point where the model can write SQL costs
              no tool call at all.
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

        {/* Rows and numbering come from `targets.ts`, so a new target is one edit. */}
        <section className="landblock" id="run">
          <div className="landhead">
            <span className="label label-sm kicker">[ Ways to run it ]</span>
            {/* `.mark` is a painted box; keep it on one line so it isn't broken in two. */}
            <h2 className="landtitle">
              Pick a place.
              <br />
              The steps are
              <br />
              <span className="mark">the same shape</span>
            </h2>
            <p>
              Every target below answers the same four questions in the same order: what you need,
              what to run, how you know it worked, and the one thing that catches people out. No
              target skips one.
            </p>

            {/* Jumps derived from the list, doubling as the section's table of contents. */}
            <div className="chips target-jumps">
              {RUN_TARGETS.map((target) => (
                <a className="chip" href={`#${target.id}`} key={target.id}>
                  {target.nav}
                </a>
              ))}
            </div>

            {/* Guarded: the route is `null` in a dashboard build, which this page is never in. */}
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

        <section className="cta cta-centred">
          <span className="label label-sm kicker">[ Self-hosted, for now ]</span>
          <h2>Bring it up. Sign up against your own address.</h2>
          <p>
            There is no hosted Ingot yet, and we would rather say that at the top than let you find
            out three scrolls down. It is a NestJS service, a Postgres and a bucket. However you
            choose to run those three, sign-up is the same open POST, and the secret still comes
            back exactly once.
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
