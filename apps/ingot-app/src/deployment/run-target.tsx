import type { ReactNode } from 'react';
import { CodeBlock } from '../docs/code-block';
import { Prose } from '../docs/prose';
import { SampleTone } from '../docs/reference';
import type { RunTarget } from './targets';

/**
 * One way of running Ingot: the argument on the left, the commands on the right.
 * Shared by the landing page and `/deployment`. The number is the row's position,
 * so inserting a target renumbers the rest.
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
