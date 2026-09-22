import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { proofCards, TABLES } from '../benchmarks/benchmarks';
import { SampleLang, SampleTone } from '../docs/reference';
import { BENCHMARKS_HREF, DEPLOYMENT_HREF, DOCS_HREF, REPO_URL, WHY_HREF } from '../site/mode';
import './landing.css';
import {
  AI_SDK_SEEN,
  AI_SDK_TOOL,
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
  WAYS_IN,
} from './sections';

/**
 * How to run it is the deployment page's, and only there. The fallback is for
 * a dashboard build, which never serves this page but is what a test run is.
 */
const RUN_HREF = DEPLOYMENT_HREF ?? REPO_URL;
const RUN_LOCAL_HREF = DEPLOYMENT_HREF ? `${DEPLOYMENT_HREF}#run-local` : REPO_URL;

/**
 * The ordinary corpus, which is the one a landing page can lead with.
 *
 * `TABLES[0]` rather than a search for the label: the publisher writes the
 * ordinary run first and any variant after it. Empty until a run is published,
 * and the block is left out entirely in that case.
 */
const PROOF = proofCards(TABLES[0] ?? null);

/**
 * What the run was, counted rather than written down.
 *
 * The artboard's version says "sixty questions, six task classes, three runs
 * each", which was true of the run it was drawn against and is a sentence
 * nobody re-reads when the next one publishes. These three are the same three
 * figures, read off the table the cards under them come from.
 */
const PROOF_RUN = TABLES[0]?.run ?? null;
const PROOF_LEDE = PROOF_RUN
  ? `${PROOF_RUN.questions} questions, ${TABLES[0]?.categories.length ?? 0} task classes, ` +
    `${PROOF_RUN.repeats} runs each. Accuracy above, what it cost to get there below.`
  : '';

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

          <div className="label label-sm speaks-label">Features</div>
          <div className="speaks">
            {SPEAKS.map((thing) => (
              <span key={thing}>{thing}</span>
            ))}
          </div>
        </section>

        {/*
          What the thing is, before any of the API below it.

          The hero says it in one sentence and a sentence is not enough: a
          reader arriving here has to be told that this is where an agent loop
          puts its tool results, or they read the terminal underneath as a
          database's samples rather than as an ingot's. The `/why` link sits in
          the head rather than in a fourth cell because the argument is not a
          feature — and it is guarded, because the route is `null` in a build
          that does not have that page.
        */}
        <section className="landblock" id="what">
          <div className="landhead">
            <span className="label kicker kicker-n">What it is</span>
            <h2 className="landtitle">
              Queryable
              <br />
              <span className="mark">memory</span>
            </h2>
            {WHY_HREF ? (
              <a className="target-more landhead-more" href={WHY_HREF}>
                The argument, in full →
              </a>
            ) : null}
          </div>

          <div className="features">
            {WAYS_IN.map((way) => (
              <div className="feature" key={way.id}>
                <div className="feature-kicker">{way.kicker.toUpperCase()}</div>
                <h4>{way.title}</h4>
                <p>{way.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/*
          What the claims above cost, and what they are made of — the measured
          columns beside the two calls that produce them.

          One split rather than two bands, because they answer the same
          question from opposite ends: the left says the retrieval is better,
          the right says it is two POSTs. Each half is a head of its own in the
          system's idiom — flush-left kicker, display title, one paragraph —
          so neither reads as a caption on the other.
        */}
        <section className="split split-heads" id="benchmark">
          <div className="split-copy">
            <span className="label kicker kicker-n">Benchmark</span>
            <h3>
              Structured beats
              <br />
              similarity
            </h3>
            <p>{PROOF_LEDE}</p>

            {PROOF.length > 0 ? (
              <div className="proof">
                {PROOF.map((card) => (
                  <div
                    className={card.lead ? 'proof-card proof-lead' : 'proof-card'}
                    key={card.name}
                  >
                    <div className="proof-head label label-sm">
                      <span className="proof-name">{card.name}</span>
                      <span
                        className={card.ranked ? 'proof-badge proof-badge-rank' : 'proof-badge'}
                      >
                        {card.badge.toUpperCase()}
                      </span>
                    </div>

                    <div className="proof-value">
                      {Math.round(card.accuracy * 100)}%
                      <span className="proof-pm">±{Math.round(card.stderr * 100)}</span>
                    </div>
                    <div className="proof-caption label label-sm">{card.caption.toUpperCase()}</div>

                    <div className="proof-stats">
                      {card.stats.map((stat) => (
                        <div className="proof-stat" key={stat.label}>
                          <div className="proof-stat-value">{stat.value}</div>
                          <div className="proof-stat-label label label-sm">
                            {stat.label.toUpperCase()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {BENCHMARKS_HREF ? (
              <a className="target-more proof-more" href={BENCHMARKS_HREF}>
                Every column, and what it does not measure →
              </a>
            ) : null}
          </div>

          <div className="split-copy">
            <span className="label kicker kicker-n">Two calls</span>
            <h3>
              Write it once,
              <br />
              once, <span className="mark">query</span> it back
            </h3>
            <p>
              No embedding step, and no re-reading the transcript. The tool result becomes a table
              the model can select from, in the same second it was written.
            </p>

            <div className="panel">
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
          </div>
        </section>

        {/*
          The README's "Against RAG", and it is here rather than at the bottom
          of the page on purpose: the sections below this one are all API, and
          a reader is owed the boundary of the thing before they are walked
          through its calls. Somebody deciding whether to run this should know
          what it leaves to something else before they bring one up.
        */}
        <section className="landblock" id="not">
          <div className="landhead">
            <span className="label kicker kicker-n">What it&rsquo;s not</span>
            <h2 className="landtitle">
              <span className="mark">RAG</span> Replacement
            </h2>
            <p>
              &ldquo;RAG&rdquo; can encompase complex document processing pipelines, but Ingot
              focuses solely on the storage and retrieval aspect, leaving the rest to other
              components.
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

        <section className="landblock" id="how">
          <div className="landhead">
            <span className="label kicker kicker-n">How it works</span>
            <h2 className="landtitle">
              <span className="mark">Cast it</span>, organize it,
              <br />
              read it back
            </h2>
            <p>
              Three calls is the whole loop. That is genuinely it — everything else you might want,
              like keys, retention, schema or MCP, hangs off the same bearer token.
            </p>
            <a className="target-more landhead-more" href="#ai-sdk">
              The same thing as a file you can type ↓
            </a>
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

          {/*
            The same three calls again, this time as the turn they sit in — the
            steps above say what each one does, and a reader still has to be
            told that none of them is a hop the harness makes. A panel rather
            than a bare grid, so four cells with arrows between them read as
            one figure instead of as four more tiles under the three above.
          */}
          <div className="landfigure">
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

        {/*
          The same thing as a file you can type.

          The diagram above is true of any harness; this is true of one, which
          is why it is its own section rather than a second figure under the
          same head — merging them would make the general claim look like a
          Vercel-shaped claim.
        */}
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
                <CodeBlock code={AI_SDK_TOOL} lang={SampleLang.Ts} />
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
              We split these two on purpose. <code>embed</code> belongs to the table: set it once
              when the table is declared and it applies to every write after that.{' '}
              <code>receipt</code> is per call, because it costs a model call every time. A loop
              storing ten thousand tool results should never end up paying for either by accident.
            </p>
            <p>
              A receipt comes back <code>pending</code>, with the SELECT that will answer it. The
              model writing the summary is a network away; your rows are queryable the instant{' '}
              <code>/add</code> returns. Point the ingot at a webhook or a queue and you get told
              instead of having to ask.
            </p>
            <div className="chips">
              <span className="chip chip-accent">embed per table</span>
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
              RAG retrieval
              <br />
              within the same service.
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
              POST against the ingot you were already writing to. Neither half is on by default —
              you turn on embeddings and the keyword index per table, so a table holding no prose
              pays for neither.
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
