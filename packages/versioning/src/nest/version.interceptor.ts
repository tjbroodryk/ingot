import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Payload } from '../change.js';
import { UnknownVersion } from '../errors.js';
import type { VersionId } from '../version.js';
import { attachVersion } from './current-version.decorator.js';
import { VERSIONING_OPTIONS, type VersioningOptions } from './options.js';
import { SHAPE_RESOLVER, type ShapeResolver } from './shape-resolver.js';
import type { ShapeRef } from './wire.decorator.js';

/**
 * Where the versions actually happen.
 *
 * An interceptor rather than middleware, because it has to run *after* the
 * guards — a service that pins a version per account needs to know who is
 * calling — and *before* the pipes, so the body it migrates is the body the
 * `ValidationPipe` then binds to a DTO. Nest's order is
 * guards → interceptors → pipes → handler, which is exactly the window.
 *
 * That ordering is also why the request half cannot be done in `map()` and the
 * response half cannot be done anywhere else.
 */
@Injectable()
export class VersionInterceptor implements NestInterceptor {
  private readonly headerKey: string;

  constructor(
    @Inject(VERSIONING_OPTIONS) private readonly options: VersioningOptions,
    @Inject(SHAPE_RESOLVER) private readonly shapes: ShapeResolver,
  ) {
    this.headerKey = options.header.toLowerCase();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Anything that is not an HTTP request — a socket, a background job — has
    // no version header and no caller to negotiate with; it speaks the current
    // shape by definition.
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    }>();
    const response = context.switchToHttp().getResponse<{
      setHeader(name: string, value: string): void;
    }>();

    const version = this.resolve(request.headers[this.headerKey]);
    attachVersion(request, version);
    // Always echoed, including when it was defaulted. A caller who did not
    // send the header is the caller most likely to be surprised by a change,
    // and this is what tells them — and their logs — which shape they got.
    response.setHeader(this.options.header, version);

    // The overwhelmingly common case, and it costs nothing: no shape lookup,
    // no copy, no `map` on the response stream.
    if (this.options.changeset.isCurrent(version)) return next.handle();

    const accepts = this.shapes.accepts(context);
    if (accepts && isPayload(request.body)) {
      request.body = this.options.changeset.forward(accepts.shape, request.body, version);
    }

    const returns = this.shapes.returns(context);
    if (!returns) return next.handle();

    return next.handle().pipe(map((body) => this.render(body, returns, version)));
  }

  private resolve(header: string | string[] | undefined): VersionId {
    const requested = Array.isArray(header) ? header[0] : header;
    if (requested === undefined || requested.trim() === '') {
      // No header means the newest shape. This service pins nothing per
      // account: an integration that does not name a version rides whatever
      // ships, which is a deliberate choice and the thing to revisit first
      // when there are callers who cannot be redeployed.
      return this.options.changeset.latest;
    }

    try {
      return this.options.changeset.parse(requested.trim());
    } catch (error) {
      if (error instanceof UnknownVersion) {
        // A 400 rather than falling back to the latest. Silently serving a
        // different version than the one asked for is how a caller discovers
        // the mismatch from corrupted data rather than from an error.
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Applies the backward chain, unwrapping a list or a page to reach the items. */
  private render(body: unknown, returns: ShapeRef, version: VersionId): unknown {
    const down = (value: unknown): unknown =>
      isPayload(value) ? this.options.changeset.backward(returns.shape, value, version) : value;

    if (returns.array) return Array.isArray(body) ? body.map(down) : body;

    if (returns.paged && isPayload(body) && Array.isArray(body.items)) {
      // The page wrapper is not itself a versioned shape — only its contents
      // are — so it is rebuilt rather than transformed.
      return { ...body, items: body.items.map(down) };
    }

    return down(body);
  }
}

/**
 * An object a transform can work on.
 *
 * Arrays are excluded deliberately: a transform is declared against one shape,
 * and handing it a list would make every change have to remember to map. The
 * unwrapping above is the interceptor's job precisely so the changes stay
 * simple.
 */
function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
