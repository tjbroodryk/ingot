/** The Nest half of `@ingot/versioning`. */
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
