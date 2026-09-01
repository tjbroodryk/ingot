import type { ReactNode } from 'react';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { SampleTone } from '../docs/reference';
import type { RunTarget } from './targets';

/**
 * One way of running Ingot: the argument on the left, the commands on the
 * right, in the order `targets.ts` names its slots.
 *
 * Shared by the two pages that list them rather than written twice, for the
 * reason `NavGroup` is shared: the landing page and `/deployment` should not
 * be able to disagree about what a target looks like, and more to the point
 * they should not be able to disagree about which of the four questions a
 * target answers. A row that renders three slots on one page and four on the
 * other would make the claim the landing head prints — that none of them is
 * left out — true only where somebody last looked.
 *
 * What the two pages do differ on is what surrounds the rows, which is the
 * whole of the difference between a pitch and a runbook.
 *
 * The number is the row's position rather than something the data carries, so
 * inserting a target renumbers the rest instead of leaving two `02`s — the
 * same reason `STEPS` can afford to write its own and this cannot.
 */
export function RunTargetRow({ target, index }: { target: RunTarget; index: number }): ReactNode {
  return (
    <article className="target" id={target.id}>
      <div className="target-copy">
        <div className="target-num">
          {String(index + 1).padStart(2, '0')} · {target.kicker}
        </div>
        <h3>{target.title}</h3>
        <p className="target-summary">
          <Prose text={target.summary} />
        </p>

        <div className="label label-sm target-slot">Needs</div>
        <ul className="target-needs">
          {target.needs.map((need) => (
            <li key={need}>
              <Prose text={need} />
            </li>
          ))}
        </ul>

        <div className="label label-sm target-slot">Catches people</div>
        <p className="target-catch">
          <Prose text={target.catches} />
        </p>

        <a className="target-more" href={target.more.href}>
          {target.more.label} →
        </a>
      </div>

      <div className="target-figure">
        <div className="label label-sm target-slot">Run</div>
        <CodeBlock code={target.run} tone={SampleTone.Ink} />
        <div className="label label-sm target-slot">Check</div>
        <CodeBlock code={target.check} />
      </div>
    </article>
  );
}
