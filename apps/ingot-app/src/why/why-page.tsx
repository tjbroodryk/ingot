import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ContentsRail } from '../chrome/contents-rail';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { Prose } from '../docs/prose';
import { BENCHMARKS_HREF, DOCS_HREF, FEATURES_HREF, REPO_URL } from '../site/mode';
// The frame and the closing band are the landing page's.
import '../landing/landing.css';
import './why.css';
import {
  ABSTRACT,
  CONCLUSION,
  type Evidence,
  evidence,
  HYPOTHESIS,
  INTRODUCTION,
  readingMinutes,
  WHY_DESCRIPTION,
  WHY_SECTIONS,
} from './why';

export const whyMetadata: Metadata = {
  // The nav's word rather than the headline: a tab is read at 90px wide.
  title: 'Why Ingot',
  description: WHY_DESCRIPTION,
};

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Why Ingot is shaped the way it is, drawn to the Ingot Why artboard: a short
 * argument in four parts, set as a paper with a contents rail beside it.
 */
export function WhyPage(): ReactNode {
  const found = evidence();

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
        <section className="why-title">
          <div className="why-wrap">
            <div className="why-badge label">
              <span className="badge">Why Ingot</span>
              <span className="muted">A short argument in four parts</span>
            </div>

            <h1 className="why-h1">
              Memory is a
              <br />
              <span className="mark">query problem</span>
            </h1>

            <dl className="why-meta label">
              <div>
                <dt>Author</dt>
                <dd>The Ingot team</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>September 2026</dd>
              </div>
              <div>
                <dt>Reading time</dt>
                <dd>{readingMinutes()} minutes</dd>
              </div>
              {found ? (
                <div>
                  <dt>Evidence</dt>
                  <dd>
                    {BENCHMARKS_HREF ? (
                      <a href={BENCHMARKS_HREF}>Run {found.runDate}</a>
                    ) : (
                      `Run ${found.runDate}`
                    )}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </section>

        <div className="railbody why-body">
          <aside className="railbody-aside">
            <ContentsRail items={WHY_SECTIONS} />
          </aside>

          <article className="railbody-main">
            <div className="why-abstract">
              <div className="why-kicker label label-sm">Abstract</div>
              <p>{ABSTRACT}</p>
            </div>

            <section className="why-section" id="introduction">
              <div className="why-measure">
                <span className="label kicker kicker-n">Introduction</span>
                <h2 className="why-h2">{INTRODUCTION.title}</h2>
                {INTRODUCTION.before.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                <blockquote className="why-quote">{INTRODUCTION.quote}</blockquote>
                {INTRODUCTION.joins.map((paragraph) => (
                  <p key={paragraph}>
                    <Prose text={paragraph} />
                  </p>
                ))}
              </div>

              <Contrast />

              <div className="why-measure">
                <p>{INTRODUCTION.after}</p>
              </div>
            </section>

            <section className="why-section" id="hypothesis">
              <div className="why-measure">
                <span className="label kicker kicker-n">Hypothesis</span>
                <h2 className="why-h2">{HYPOTHESIS.title}</h2>
                <p>{HYPOTHESIS.body}</p>
              </div>

              <div className="why-claim">
                <div className="why-claim-bar label label-sm">Stated claim</div>
                <div className="why-claim-cells">
                  {HYPOTHESIS.claims.map((claim) => (
                    <div className="why-claim-cell" key={claim.n}>
                      <div className="why-claim-n label label-sm">{claim.n}</div>
                      <div>{claim.text}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="why-falsifier">
                <div className="why-kicker label label-sm">What would prove it wrong</div>
                <p>{HYPOTHESIS.falsifier}</p>
              </div>
            </section>

            <section className="why-section" id="evidence">
              <div className="why-measure">
                <span className="label kicker kicker-n">Evidence</span>
                <h2 className="why-h2">What the benchmark shows</h2>
                {found ? (
                  <p>{found.method}</p>
                ) : (
                  <p>No run has been published yet with both columns this section compares.</p>
                )}
              </div>
              {found ? <Findings found={found} /> : null}
              {BENCHMARKS_HREF ? (
                <div className="why-measure">
                  <a className="why-more label" href={BENCHMARKS_HREF}>
                    Full results, questions and transcripts →
                  </a>
                </div>
              ) : null}
            </section>

            <section className="why-section" id="conclusion">
              <div className="why-measure">
                <span className="label kicker kicker-n">Conclusion</span>
                <h2 className="why-h2">{CONCLUSION.title}</h2>
                {CONCLUSION.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>

              <div className="why-open">
                <div className="why-open-label label label-sm">Still to show</div>
                <ol>
                  {CONCLUSION.open.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </div>
            </section>
          </article>
        </div>

        <section className="cta cta-row">
          <div>
            <span className="label kicker">[ Next ]</span>
            <h2>Test the claim yourself</h2>
          </div>
          <div className="cta-actions">
            <a className="cta-primary" href={REPO_URL}>
              Get the source
            </a>
            {FEATURES_HREF ? (
              <a className="btn-outline btn-lg cta-secondary" href={FEATURES_HREF}>
                See the features
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

/** One join question answered twice: by chunks that read alike, and by SQL. */
function Contrast(): ReactNode {
  const { guess, exact } = INTRODUCTION.contrast;
  return (
    <div className="why-contrast">
      <div className="why-contrast-cell">
        <div className="why-contrast-head">
          <span className="label label-sm muted">{guess.label}</span>
          <span className="why-tag label label-sm">{guess.tag}</span>
        </div>
        <div className="why-chunks">
          {guess.chunks.map((chunk) => (
            <div className="why-chunk" key={chunk}>
              {chunk}
            </div>
          ))}
        </div>
        <p className="why-contrast-note">
          <Prose text={guess.note} />
        </p>
      </div>

      <div className="why-contrast-cell why-contrast-exact">
        <div className="why-contrast-head">
          <span className="label label-sm why-accent">{exact.label}</span>
          <span className="why-tag why-tag-exact label label-sm">{exact.tag}</span>
        </div>
        <pre className="why-join">{exact.sql}</pre>
        <p className="why-contrast-note">
          <Prose text={exact.note} />
        </p>
      </div>
    </div>
  );
}

function Findings({ found }: { found: Evidence }): ReactNode {
  return (
    <>
      <div className="why-stats">
        <div>
          <div className="why-stat-value">{pct(found.ours.accuracy)}</div>
          <div className="why-stat-label label label-sm">{found.oursLabel} accuracy</div>
        </div>
        <div>
          <div className="why-stat-value">{pct(found.baseline.accuracy)}</div>
          <div className="why-stat-label label label-sm">{found.baselineLabel} accuracy</div>
        </div>
        <div>
          <div className="why-stat-value">{found.contextRatio.toFixed(1)}×</div>
          <div className="why-stat-label label label-sm">
            Less context than {found.baselineLabel}
          </div>
        </div>
      </div>

      <figure className="why-bars">
        <figcaption className="why-bars-rule label label-sm">
          <span>
            Accuracy by task class · {found.oursLabel} vs {found.baselineLabel}
          </span>
          <span className="why-bars-line" aria-hidden="true" />
        </figcaption>
        {found.classes.map((bar) => (
          <div className="why-bar" key={bar.name}>
            <div className="why-bar-name label label-sm">{bar.name}</div>
            <div className="why-bar-track">
              <div className="why-bar-fill why-bar-ours" style={{ width: pct(bar.ours) }} />
            </div>
            <div className="why-bar-value why-bar-value-ours">{pct(bar.ours)}</div>
            <div className="why-bar-track">
              <div className="why-bar-fill" style={{ width: pct(bar.baseline) }} />
            </div>
            <div className="why-bar-value">{pct(bar.baseline)}</div>
          </div>
        ))}
        <div className="why-legend label label-sm">
          <span>
            <span className="why-swatch why-bar-ours" />
            {found.oursLabel}
          </span>
          <span>
            <span className="why-swatch" />
            {found.baselineLabel}
          </span>
        </div>
      </figure>

      <div className="why-measure">
        <p>{found.findings}</p>
      </div>
    </>
  );
}
