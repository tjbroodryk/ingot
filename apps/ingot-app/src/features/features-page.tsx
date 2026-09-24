import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ContentsRail, type RailItem } from '../chrome/contents-rail';
import { sectionNumber } from '../chrome/section-number';
import { SiteFooter } from '../chrome/site-footer';
import { SiteHeader, SiteSection } from '../chrome/site-header';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { BENCHMARKS_HREF, DOCS_HREF, REPO_URL } from '../site/mode';
// The frame, the hero and the closing band are the landing page's.
import '../landing/landing.css';
import './features.css';
import { COMBINED, FEATURES, FEATURES_DESCRIPTION, FEATURES_LEDE, type Feature } from './features';

export const featuresMetadata: Metadata = {
  title: 'Features',
  description: FEATURES_DESCRIPTION,
};

// Only what the rail reads: it is a client component, and the rest would be
// serialised into the page for nothing.
const RAIL: readonly RailItem[] = [...FEATURES, COMBINED].map(({ id, name, summary }) => ({
  id,
  title: name,
  summary,
}));

/**
 * The ways an ingot can be asked, drawn to the Ingot Features artboard: a
 * section per search mode, each with a real request beside when to reach for
 * it, then one query that combines three of them.
 */
export function FeaturesPage(): ReactNode {
  return (
    <>
      <SiteHeader
        current={SiteSection.Features}
        actions={
          <a className="btn-solid" href={REPO_URL}>
            Get the source
          </a>
        }
      />

      <div className="landframe">
        <section className="hero">
          <div className="hero-badge label">
            <span className="badge">Features</span>
            <span>Five ways in, one store</span>
          </div>

          <h1 className="hero-title feat-hero-title">
            Ask it
            <br />
            <span className="mark">any way</span>
          </h1>

          <p className="hero-lede feat-hero-lede">{FEATURES_LEDE}</p>

          <div className="hero-actions label">
            <a className="btn-solid btn-lg" href={`#${COMBINED.id}`}>
              See them combined
            </a>
            <a className="btn-outline btn-lg" href={DOCS_HREF}>
              Read the docs
            </a>
          </div>
        </section>

        <div className="railbody feat-body">
          <aside className="railbody-aside">
            <ContentsRail items={RAIL} />
          </aside>

          <div className="railbody-main">
            {FEATURES.map((feature) => (
              <FeatureBand key={feature.id} feature={feature} />
            ))}

            <section className="feat-band" id={COMBINED.id}>
              <div className="feat-wrap">
                <span className="label kicker kicker-n">{COMBINED.name}</span>
                <h2 className="feat-title">{COMBINED.title}</h2>
                <p className="feat-lede">{COMBINED.lede}</p>

                <div className="panel feat-exchange">
                  <PanelBar path={COMBINED.path} />
                  <div className="feat-combo">
                    <CodeBlock code={COMBINED.request} className="feat-code" />
                    <ol className="feat-steps">
                      {COMBINED.steps.map((step, index) => (
                        <li key={step.label}>
                          <span className="feat-step-n label">{sectionNumber(index)}</span>
                          <span>
                            <span className="feat-step-label label">{step.label}</span>
                            <span className="feat-step-text">{step.text}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="feat-status label label-sm">{COMBINED.status}</div>
                  <CodeBlock code={COMBINED.response} className="feat-code feat-response" />
                </div>
              </div>
            </section>
          </div>
        </div>

        <section className="cta cta-row">
          <div>
            <span className="label kicker">[ Start ]</span>
            <h2>Cast your first ingot</h2>
          </div>
          <div className="cta-actions">
            <a className="cta-primary" href={REPO_URL}>
              Get the source
            </a>
            {BENCHMARKS_HREF ? (
              <a className="btn-outline btn-lg cta-secondary" href={BENCHMARKS_HREF}>
                See the benchmarks
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

function FeatureBand({ feature }: { feature: Feature }): ReactNode {
  return (
    <section className="feat-band" id={feature.id}>
      <div className="feat-wrap">
        <span className="label kicker kicker-n">{feature.name}</span>
        <h2 className="feat-title">{feature.title}</h2>
        <p className="feat-lede">
          <Prose text={feature.lede} />
        </p>

        <div className="feat-split">
          <div className="panel feat-exchange">
            <PanelBar path={feature.path} />
            <CodeBlock code={feature.request} className="feat-code" />
            <div className="feat-status label label-sm">{feature.status}</div>
            <CodeBlock code={feature.response} className="feat-code feat-response" />
          </div>

          <div className="feat-aside">
            <div className="feat-when">
              <div className="feat-aside-label label label-sm">Reach for it when</div>
              <ul>
                {feature.when.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="feat-not">
              <div className="feat-aside-label label label-sm">Not the right tool when</div>
              <p>{feature.not}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Every call on this page is a POST: the reads carry a body too. */
function PanelBar({ path }: { path: string }): ReactNode {
  return (
    <div className="panel-bar">
      <span className="method method-post">POST</span>
      <span className="feat-path">{path}</span>
    </div>
  );
}
