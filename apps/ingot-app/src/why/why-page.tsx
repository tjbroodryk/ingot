import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { DEPLOYMENT_HREF, DOCS_HREF, HOME_HREF, REPO_URL } from '../site/mode';
// The landing page's layout, used rather than restated — see the note at the
// top of that file. This page is the same shape of argument in the same
// idiom: a hero, ruled bands, three-up grids and two splits.
import '../landing/landing.css';
import './why.css';
import {
  COSTS,
  GRAIN_CHIPS,
  GRAIN_LIMIT,
  GRAINS,
  LOSS_CLAIM,
  LOSSES,
  OWN_IT,
  OWNERSHIP_CHIPS,
  SQL_NOTES,
  THE_JOIN,
  THREE_TOOLS,
  TIERS,
  VECTOR_COLUMN,
  WHY_DESCRIPTION,
  WHY_LEDE,
} from './why';

export const whyMetadata: Metadata = {
  // The nav's word rather than the headline, the way `/deployment` uses
  // "Deployment" and not "Three places, two dependencies". A tab is read at
  // 90px wide, and "Similarity is not a join · Ingot" truncates to nothing
  // that says which page it is.
  title: 'Why Ingot',
  description: WHY_DESCRIPTION,
};

/**
 * Why this exists at all — the one page on the site that argues rather than
 * describes.
 *
 * The reference says what Ingot serves and `/deployment` says how to have one.
 * Neither answers the question somebody asks before either of those is worth
 * reading: why is this not a vector store, like everything else that calls
 * itself agent memory. That question has an answer, the answer is the reason
 * the service is shaped the way it is, and burying it in a landing-page
 * section would make it look like a feature.
 *
 * The order is the argument, and each section is load-bearing for the one
 * after it:
 *
 *   #problem     what happens to a tool result today, and why all three
 *                answers lose the same thing
 *   #sql         the swap — tables and one SELECT — with the join no single
 *                tool call could have answered
 *   #vectors     where the embeddings went, so that this does not read as an
 *                argument against them
 *   #grain       what one memory is scoped to, which is the caller's decision
 *                and the page says so, limit included
 *   #cost        why keeping it all is affordable, which is what makes the
 *                grain a free choice rather than a budget
 *   #ownership   whose it is, which is the only claim self-hosting is what
 *                makes true
 *
 * A server component with nothing to fetch: it renders once, at build time.
 */
export function WhyPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Why}
        actions={
          <a className="btn-solid" href={REPO_URL}>
            Get the source
          </a>
        }
      />

      <div className="landframe">
        <section className="hero">
          <div className="hero-badge label">
            <span className="badge">The argument</span>
            <a href="#problem">Why this is not a vector store</a>
          </div>

          <h1 className="hero-title">
            Similarity is
            <br />
            not <span className="mark">a join</span>
          </h1>

          <p className="hero-lede">{WHY_LEDE}</p>

          <div className="hero-actions label">
            <a className="btn-solid btn-lg" href="#sql">
              Read the argument
            </a>
            <a className="btn-outline btn-lg" href={DOCS_HREF}>
              View docs
            </a>
          </div>
        </section>

        {/*
          The problem, stated as an exhaustive list rather than a complaint.

          Three cells because there are three things anybody does with a tool
          result, and the section only works if a reader cannot think of a
          fourth — otherwise it is an argument against two of the options
          somebody has.
        */}
        <section className="landblock" id="problem">
          <div className="landhead">
            <span className="label label-sm kicker">[ What happens today ]</span>
            <h2 className="landtitle">
              Three ways to lose
              <br />
              <span className="mark">a tool result</span>
            </h2>
            <p>
              You have watched this happen. A tool returns four hundred rows of structured JSON, and
              by the next turn one of these three things has happened to it. You cannot query any of
              them.
            </p>
          </div>

          <div className="steps">
            {LOSSES.map((loss) => (
              <div className="step" key={loss.kicker}>
                <div className="step-num">{loss.kicker.toUpperCase()}</div>
                <h4>{loss.title}</h4>
                <p>{loss.body}</p>
                <code>{loss.cost}</code>
              </div>
            ))}
          </div>

          <div className="why-strip">
            <Prose text={LOSS_CLAIM} />
          </div>
        </section>

        {/*
          The swap, and the whole page turns on the figure rather than on the
          copy: three writes on the left that know nothing about each other,
          one statement on the right that joins all three. A reader who reads
          only the right-hand pane has had the argument.
        */}
        <section className="landblock" id="sql">
          <div className="landhead">
            <span className="label label-sm kicker">[ Why SQL ]</span>
            <h2 className="landtitle">
              Models write SQL.
              <br />
              <span className="mark">Let them.</span>
            </h2>
            <p>
              It is the most written-down query language there is, and a model is fluent in it in a
              way it will never be fluent in your retrieval API. It also fails loudly, which is the
              part we care about most: a SELECT either returns rows or it errors with a reason, and
              a model that got it wrong can narrow it and try again. A ranking always returns
              something. Being wrong looks exactly like being right — and that is a horrible
              property in a system you are trying to learn to trust.
            </p>
          </div>

          <div className="landfigure">
            <div className="panel panel-wide">
              <div className="panel-bar">
                <span className="panel-glyph">≡ ×</span>
                <span className="panel-rule" />
                <span>Ingot · one memory, three tools</span>
                <span className="panel-rule" />
              </div>
              <div className="panel-split">
                <CodeBlock code={THREE_TOOLS} />
                <CodeBlock code={THE_JOIN} />
              </div>
            </div>
          </div>

          {/*
            `.steps` again, because these are the same object the landing
            page's SDK notes are: a kicker, a claim, and the line of the
            service it is true because of.
          */}
          <div className="steps">
            {SQL_NOTES.map((note) => (
              <div className="step" key={note.kicker}>
                <div className="step-num">{note.kicker.toUpperCase()}</div>
                <h4>{note.title}</h4>
                <p>{note.body}</p>
                <code>{note.source}</code>
              </div>
            ))}
          </div>
        </section>

        {/*
          Said immediately after the join, and not later, because a page that
          spends a screen on "similarity is not a join" and only reconciles it
          three sections down has been read as anti-embedding by then.
        */}
        <section className="split" id="vectors">
          <div className="split-copy">
            <span className="label label-sm kicker">[ Where the embeddings went ]</span>
            <h3>
              Not a database.
              <br />
              A column.
            </h3>
            <p>
              We use embeddings. None of this is an argument against them — it is an argument about
              where they belong. A vector is a column sitting beside the row it was made from, and{' '}
              <code>array_cosine_similarity(body_vec, $q)</code> is an expression in a SELECT list
              like any other.
            </p>
            <p>
              So meaning becomes one predicate in a statement that also joins two tables, filters on
              a real date, and counts. The setup with a vector store bolted on the side cannot write
              that statement at all: the vectors are over there, the columns are over here, and the
              only thing that ever crosses between them is a list of ids.
            </p>
            <div className="chips">
              <span className="chip chip-accent">one SELECT</span>
              <span className="chip">cosine</span>
              <span className="chip">BM25</span>
              <span className="chip">a real WHERE</span>
              <span className="chip">no second store</span>
            </div>
            <a className="target-more" href={`${HOME_HREF}#read`}>
              How retrieval works, on the landing page →
            </a>
          </div>
          <div className="split-figure">
            <CodeBlock code={VECTOR_COLUMN} />
          </div>
        </section>

        {/*
          The reader's decision, and the section that answers "per what?".

          The limit under the grid is not a caveat tucked at the end — it is
          the thing that makes the choice a choice, and it is the one claim on
          this page somebody could build on and be disappointed by later.
        */}
        <section className="landblock" id="grain">
          <div className="landhead">
            <span className="label label-sm kicker">[ One memory per what ]</span>
            <h2 className="landtitle">
              One memory per
              <br />
              <span className="mark">whatever you say</span>
            </h2>
            <p>
              Ingot has no opinion about what a memory is for. Casting one is a POST with a name and
              a retention, so the boundary can just be the boundary your system already has — a
              chat, a run, a project, a tenant.
            </p>
          </div>

          {/*
            `.features` for the cell, `.grains` for the grid: four across
            rather than three, because these are a sequence — shortest
            retention to none at all — and a 3 + 1 wrap reads as three options
            and an afterthought.
          */}
          <div className="features grains">
            {GRAINS.map((grain) => (
              <div className="feature" key={grain.title}>
                <div className="feature-kicker">{grain.retention}</div>
                <h4>{grain.title}</h4>
                <p>{grain.body}</p>
              </div>
            ))}
          </div>

          <div className="grain-limit">
            <p>
              <Prose text={GRAIN_LIMIT} />
            </p>
            <div className="chips">
              {GRAIN_CHIPS.map((chip) => (
                <span className="chip" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/*
          Why the section above is a free choice. Keeping a memory per chat is
          only reasonable if a memory per chat is nearly free, so the storage
          model has to be on this page rather than only on `/deployment`.
        */}
        <section className="landblock" id="cost">
          <div className="landhead">
            <span className="label label-sm kicker">[ What it costs to keep ]</span>
            <h2 className="landtitle">
              Cheap enough
              <br />
              <span className="mark">to keep it all</span>
            </h2>
            <p>
              An LSM tree, and nothing more exotic than that. None of it is resident: no index to
              keep warm, no cluster sized to the corpus, and nothing that bills you per vector.
            </p>
          </div>

          <div className="steps">
            {TIERS.map((tier) => (
              <div className="step" key={tier.n}>
                <div className="step-num">{tier.n}</div>
                <h4>{tier.title}</h4>
                <p>{tier.body}</p>
                <code>{tier.note}</code>
              </div>
            ))}
          </div>

          {/*
            The ledger, including the lines that are zero — which are the
            argument. Everything above is a mechanism; this is the bill it
            produces.
          */}
          <div className="why-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="cost-item-col">What a memory costs</th>
                  <th>What that is</th>
                </tr>
              </thead>
              <tbody>
                {COSTS.map((cost) => (
                  <tr key={cost.item}>
                    <td>{cost.item}</td>
                    <td className="prose">
                      <Prose text={cost.body} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/*
          Last, because it is the only claim the previous five do not make on
          their own: everything above would still be true of a hosted service,
          and none of it would be yours.
        */}
        <section className="split" id="ownership">
          <div className="split-figure">
            <CodeBlock code={OWN_IT} />
          </div>
          <div className="split-copy">
            <span className="label label-sm kicker">[ Self-deployed ]</span>
            <h3>
              Your bucket.
              <br />
              Your rows.
            </h3>
            <p>
              There is no hosted Ingot, and on this page that is the point rather than the caveat.
              The Postgres is yours, the bucket is yours, and what sits in the bucket is Parquet.
              Not an index. Not a proprietary segment file. Not something that needs this service
              running before you can read it.
            </p>
            <p>
              Which means there is no export step, because there is no second format to export from.
              A table&rsquo;s current generation is one file, and anything that reads Parquet reads
              it — DuckDB on your laptop, pandas, Spark, whatever you already pay for. If Ingot
              stops, the memory does not.
            </p>
            <div className="chips">
              {OWNERSHIP_CHIPS.map((chip) => (
                <span className="chip" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="cta cta-centred">
          <span className="label label-sm kicker">[ The argument is a repository ]</span>
          <h2>Every claim above is a file you can go and disagree with</h2>
          <p>
            The join is the query handler, the five minutes is a sweeper, the sandbox is two hundred
            lines of guard, and the bucket layout is one object. Nothing on this page is a position
            the code does not already hold — so if you think we have got one of them wrong, the
            place to say so is the repository.
          </p>

          <div className="cta-actions">
            <a className="cta-primary" href={REPO_URL}>
              Get the source
            </a>
            {DEPLOYMENT_HREF ? (
              <a className="btn-outline btn-lg cta-secondary" href={DEPLOYMENT_HREF}>
                Run one yourself
              </a>
            ) : null}
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
