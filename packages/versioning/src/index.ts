/**
 * API versioning: one implementation, many contracts. A caller names a version
 * in a header; the newest shape is the only one implemented, and older ones are
 * that shape with two-way transforms in front of it. See `changeset.ts` for the
 * model and `./nest` for the interceptor.
 */
export { Changeset } from './changeset.js';
export type { Payload, Release, ShapeChange } from './change.js';
export { MalformedChangeset, UnknownVersion } from './errors.js';
export { compareVersions, isVersionId, type VersionId } from './version.js';
