import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { SampleTone } from '../docs/reference';
import { BENCHMARKS_HREF, DEPLOYMENT_HREF, DOCS_HREF, REPO_URL, WHY_HREF } from '../site/mode';
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
  RAG_LEFT_OUT,
  RAG_REPLACED,
  RECALL,
  RECEIPTS,
  REMEMBER,
  RETRIEVAL,
  SDK_NOTES,
  SPEAKS,
  STEPS,
} from './sections';

/**
 * How to run it is the deployment page's, and only there. The fallback is for
 * a dashboard build, which never serves this page but is what a test run is.
 */
const RUN_HREF = DEPLOYMENT_HREF ?? REPO_URL;
const RUN_LOCAL_HREF = DEPLOYMENT_HREF ? `${DEPLOYMENT_HREF}#run-local` : REPO_URL;

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
            <a href={RUN_HREF}>There is no hosted Ingot yet — you run it</a>
          </div>

          <h1 className="hero-title">
            Memory your
            <br />
            <span className="mark">model can query</span>
          </h1>

          {/* Also `layout.tsx`'s `description` — see the constant. */}
          <p className="hero-lede">{LEDE}</p>

          <div className="hero-actions label">
            <a className="btn-solid btn-lg" href={RUN_LOCAL_HREF}>
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
            <span className="label kicker kicker-n">How it works</span>
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
            <span className="label kicker kicker-n">What you get</span>
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

        {/*
          Where the thing actually goes.

          Everything above this is the API. This pair is the paragraph of your
          own code that calls it, and it is told twice on purpose — once as a
          diagram, because the point is a swap and a swap is a shape, and once
          as a file, because a reader who is convinced now wants to type
          something. Two sections rather than one: the diagram is true of any
          harness and the sample is true of one, and merging them would make
          the general claim look like a Vercel-shaped claim.

          It sits after the features and before the splits because it is the
          synthesis — `/add`, the receipt and `/query` all appear in it, and it
          reads as a summary rather than as a fourth new idea.
        */}
        <section className="landblock" id="harness">
          <div className="landhead">
            <span className="label kicker kicker-n">In the agent loop</span>
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
            {/*
              A panel rather than a bare grid, so it reads as one figure with
              four cells instead of as four more feature tiles — this page has
              a lot of three-up grids by now and the loop is not another one.
            */}
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

              {/*
                The arrowheads run one way across the lane; this is the one
                that runs back, and it is the whole reason the loop is drawn as
                a loop rather than as a pipeline.
              */}
              <div className="wire-return">{HARNESS_RETURN}</div>
            </div>
          </div>
        </section>

        <section className="landblock" id="ai-sdk">
          <div className="landhead">
            <span className="label kicker kicker-n">Vercel AI SDK</span>
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

          {/*
            `.steps` again, because these are the same object — a kicker, a
            claim, and the line of API it is about. The cells happen to be
            labelled rather than numbered, which is the data's business and not
            the grid's.
          */}
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

        {/*
          Figure first, so the alternation with `#read` and `#mcp` holds: this
          page reads left-figure, right-figure, left-figure down the splits.
        */}
        <section className="split" id="receipts">
          <div className="split-figure">
            <CodeBlock code={RECEIPTS} />
          </div>
          <div className="split-copy">
            <span className="label kicker kicker-n">Receipts &amp; embeddings</span>
            <h3>
              Opt in to the
              <br />
              expensive parts.
            </h3>
            <p>
              We split these two on purpose. <code>embed</code> belongs to the memory type: set it
              once when the type is declared and it applies to every write after that.{' '}
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
              <span className="chip chip-accent">embed per memory type</span>
              <span className="chip">receipt per call</span>
              <span className="chip">webhook</span>
              <span className="chip">rabbitmq</span>
            </div>
          </div>
        </section>

        <section className="split" id="read">
          <div className="split-copy">
            <span className="label kicker kicker-n">Retrieval, and RAG</span>
            <h3>
              RAG retrieval.
              <br />
              No second database.
            </h3>
            {/*
              "SQL on its own" rather than a third `<code>` — the sentence
              before it ends on one, and two accent words with only a full stop
              between them read as a single token rather than as two clauses.
            */}
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
              you turn on embeddings and the keyword index per memory type, so a memory holding no
              prose pays for neither.
            </p>
            <div className="chips">
              <span className="chip chip-accent">one SELECT</span>
              <span className="chip">cosine</span>
              <span className="chip">BM25</span>
              <span className="chip">metadata filter</span>
              <span className="chip">no vector db</span>
            </div>
            {/*
              This section says what the retrieval does; `/why` says why it is
              the shape of the whole service rather than a feature of it.
              The link is here rather than in the hero because a reader who has
              got this far is the one the argument is for — and it is guarded
              because the route is `null` in a build that does not have it.
            */}
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
            <span className="label kicker kicker-n">MCP native</span>
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

        {/*
          The README's "Against RAG", last before the sign-up band: somebody
          deciding whether to run this should know what it leaves to something
          else before they bring one up.
        */}
        <section className="landblock" id="not">
          <div className="landhead">
            <span className="label kicker kicker-n">What it&rsquo;s not</span>
            <h2 className="landtitle">
              Half of RAG.
              <br />
              <span className="mark">The half that finds</span>
            </h2>
            <p>
              &ldquo;RAG&rdquo; names two things that come apart: store documents so a model can
              find them, and put the top k chunks in the prompt. Ingot is the first. It replaces the
              half of the stack that stores and finds, and does no part of the half that writes the
              answer.
            </p>
            {BENCHMARKS_HREF ? (
              <a className="target-more landhead-more" href={BENCHMARKS_HREF}>
                The same rows through top-k alone, measured →
              </a>
            ) : null}
          </div>

          <table className="contrast">
            <thead>
              <tr>
                <th scope="col">The job</th>
                <th scope="col">A full RAG stack</th>
                <th scope="col">Ingot</th>
              </tr>
            </thead>
            {[
              { label: 'What it replaces', rows: RAG_REPLACED },
              { label: 'What it leaves out', rows: RAG_LEFT_OUT },
            ].map((group) => (
              <tbody key={group.label}>
                <tr className="contrast-group">
                  <th colSpan={3} scope="rowgroup">
                    {group.label}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.job}>
                    <th scope="row">{row.job}</th>
                    {/* The labels are for the stacked layout, where the header row is gone. */}
                    <td data-label="A full RAG stack">
                      <Prose text={row.rag} />
                    </td>
                    <td data-label="Ingot">
                      <Prose text={row.ingot} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </section>

        {/*
          Where the design put "Sign up. The secret is shown once." There is
          nothing to sign up to, so this is the same band saying the true
          version: the sign-up route is real, and it is on the instance you
          brought up yourself. The commands for that live on the deployment
          page, so that the bring-up is written down once.
        */}
        <section className="cta">
          <span className="label kicker kicker-n">Self-hosted, for now</span>
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
