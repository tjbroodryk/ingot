/**
 * Stripe-style API versioning: one implementation, many contracts.
 *
 * A caller names a version in a header. The newest shape is the only one
 * implemented; every older one is that shape with a stack of small, two-way
 * transformations in front of it. See `changeset.ts` for the model and
 * `./nest` for the interceptor that applies it.
 *
 * Framework-agnostic on purpose — the engine is pure functions over decoded
 * JSON, which is what makes a version's behaviour testable without a server.
 */
export { Changeset } from './changeset.js';
export type { Payload, Release, ShapeChange } from './change.js';
export { MalformedChangeset, UnknownVersion } from './errors.js';
export { compareVersions, isVersionId, type VersionId } from './version.js';
