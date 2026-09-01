import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { VersionId } from '../version.js';

const VERSION = Symbol.for('versioning.served');

interface Carrier {
  [VERSION]?: VersionId;
}

/**
 * The one place the served version is written to a request and read back.
 *
 * A symbol rather than `request.apiVersion`, so nothing downstream can set it
 * by assigning a plausible-looking property.
 */
export function attachVersion(request: object, version: VersionId): void {
  (request as Carrier)[VERSION] = version;
}

export function versionOf(request: object): VersionId | undefined {
  return (request as Carrier)[VERSION];
}

/**
 * The version this request is being served as.
 *
 * Rarely needed — the whole point is that a handler implements one shape and
 * never asks. It exists for the cases a transform genuinely cannot cover, such
 * as a route whose *behaviour* changed rather than its shape, and reaching for
 * it is a sign the change wants rethinking as a transform first.
 */
export const ServedVersion = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VersionId | undefined =>
    versionOf(context.switchToHttp().getRequest()),
);
