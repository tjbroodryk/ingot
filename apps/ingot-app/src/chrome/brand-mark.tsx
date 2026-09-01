import type { ReactNode } from 'react';

/**
 * The icon, without its ground.
 *
 * `src/app/icon.svg` draws these same three shapes on a blue square, because a
 * favicon has to hold together against whatever colour a browser puts behind
 * it. A page already has a ground — the warm off-white everything else sits on
 * — so carrying the square onto it would make the brand a tile with a logo
 * inside rather than a logo. What is left is the drawing.
 *
 * The coordinates are the icon's own, cropped by the viewBox rather than
 * shifted: `12 14 40 36` is the bounding box of the three shapes within that
 * file's 64 unit grid. The two drawings cannot drift apart, because they are
 * the same numbers.
 *
 * `currentColor` so the caller owns the colour, and the muted rule keeps the
 * 62% it has in the icon — there it is the accent dimmed towards a dark
 * ground, here the accent dimmed towards a light one, and either way it is the
 * quieter of the two rules.
 *
 * Sized by CSS on one axis. The viewBox gives the element an intrinsic 10:9,
 * so a height is the whole instruction and no caller restates the ratio.
 */
export function BrandMark({ className }: { className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="12 14 40 36" fill="currentColor" aria-hidden="true">
      <path d="M19 14h26l7 16H12z" />
      <rect x="12" y="38" width="40" height="4" />
      <rect x="12" y="46" width="28" height="4" fillOpacity=".62" />
    </svg>
  );
}
