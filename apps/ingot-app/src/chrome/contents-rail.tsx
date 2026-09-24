'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { sectionNumber } from './section-number';

export interface RailItem {
  readonly id: string;
  readonly title: string;
  /** The number shown beside it. Defaults to its position, from `01`. */
  readonly n?: string;
  /** A line under the title, for a rail that says what each section holds. */
  readonly summary?: string;
}

/**
 * A page's contents, pinned beside its main column, with the section being
 * read marked. Read off the layout on scroll, throttled to a frame.
 *
 * Sits in `.railbody-aside`; see `globals.css` for the layout around it.
 */
export function ContentsRail({ items }: { items: readonly RailItem[] }): ReactNode {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      frame = 0;
      let current = items[0]?.id ?? null;
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (element && element.getBoundingClientRect().top <= 160) current = item.id;
      }
      setActive(current);
    };
    const onScroll = (): void => {
      if (!frame) frame = window.requestAnimationFrame(tick);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    tick();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [items]);

  return (
    <nav className="rail" aria-label="Contents">
      <div className="rail-label label label-sm">[ Contents ]</div>
      <ol className="rail-list">
        {items.map((item, index) => (
          <li key={item.id}>
            {item.summary ? (
              <a
                className="rail-link rail-link-rich"
                href={`#${item.id}`}
                aria-current={active === item.id ? 'location' : undefined}
              >
                <span className="rail-head label">
                  <span className="rail-n">{item.n ?? sectionNumber(index)}</span>
                  <span className="rail-title">{item.title}</span>
                </span>
                <span className="rail-summary">{item.summary}</span>
              </a>
            ) : (
              <a
                className="rail-link label"
                href={`#${item.id}`}
                aria-current={active === item.id ? 'location' : undefined}
              >
                <span className="rail-n">{item.n ?? sectionNumber(index)}</span>
                {item.title}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
