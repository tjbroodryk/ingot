/**
 * A published version of an API surface, identified by the date it shipped.
 *
 * Dates rather than `v2`, `v3` for the reason Stripe uses them: a sequence
 * number says which came first and nothing else, while a date tells a reader
 * — usually someone reading an integration written by somebody who has left —
 * how old the shape they are pinned to actually is. "We are on 2026-08-26" is
 * a sentence that carries its own urgency; "we are on v3" is not.
 *
 * This is deliberately *not* the `/api/v1` in the URL. That is the major
 * surface and it does not move; this is the fine-grained contract underneath
 * it, negotiated per request by a header.
 */
export type VersionId = string;

const DATED = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed, real calendar date. `2026-02-30` is neither. */
export function isVersionId(candidate: string): boolean {
  if (!DATED.test(candidate)) return false;
  const at = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === candidate;
}

/**
 * Compares two versions.
 *
 * Lexicographic, which for `YYYY-MM-DD` is also chronological — that is the
 * whole reason the format is fixed-width and zero-padded, and why validation
 * refuses anything else. A version like `2026-8-6` would sort after
 * `2026-10-01` and reorder the changeset silently.
 */
export function compareVersions(left: VersionId, right: VersionId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
