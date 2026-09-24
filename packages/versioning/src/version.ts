/**
 * A published version of an API surface, identified by the date it shipped. Not
 * the `/api/v1` major surface in the URL — this is the finer contract underneath
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

/** Compares two versions. Lexicographic, which for `YYYY-MM-DD` is chronological. */
export function compareVersions(left: VersionId, right: VersionId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
