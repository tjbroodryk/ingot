/**
 * The Nest half of `@ingot/versioning`.
 *
 * Separate from the engine so that a version's behaviour can be tested as pure
 * functions over decoded JSON, with no server anywhere near it — which is what
 * makes a changeset cheap enough to keep honest.
 */
export { ServedVersion, attachVersion, versionOf } from './current-version.decorator.js';
export { VERSIONING_OPTIONS, type VersioningOptions } from './options.js';
export { SHAPE_RESOLVER, WireShapeResolver, type ShapeResolver } from './shape-resolver.js';
export { VersionInterceptor } from './version.interceptor.js';
export { VersioningModule, type VersioningModuleOptions } from './versioning.module.js';
export {
  WIRE_METADATA,
  Wire,
  asShapeRef,
  readWire,
  type ShapeRef,
  type WireSpec,
} from './wire.decorator.js';
