import type { ReactNode } from 'react';

/**
 * The icon, without its ground. Same three shapes as `src/app/icon.svg`, cropped
 * by the viewBox to their bounding box. `currentColor` so the caller owns the
 * colour; the viewBox gives an intrinsic 10:9, so a height is the whole size.
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
