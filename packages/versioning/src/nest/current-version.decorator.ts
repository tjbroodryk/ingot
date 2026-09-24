import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { VersionId } from '../version.js';

const VERSION = Symbol.for('versioning.served');

interface Carrier {
  [VERSION]?: VersionId;
}

/**
 * Writes the served version onto a request. A symbol key, so nothing downstream
 * can set it by assigning a plausible-looking property.
 */
export function attachVersion(request: object, version: VersionId): void {
  (request as Carrier)[VERSION] = version;
}

export function versionOf(request: object): VersionId | undefined {
  return (request as Carrier)[VERSION];
}

/**
 * The version this request is being served as. Rarely needed — for routes whose
 * behaviour changed rather than their shape.
 */
export const ServedVersion = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VersionId | undefined =>
    versionOf(context.switchToHttp().getRequest()),
);
