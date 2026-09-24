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
 * Applies versioning. An interceptor because it must run after the guards
 * (which resolve the caller) and before the pipes (which bind the migrated body
 * to a DTO): guards → interceptors → pipes → handler.
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
    // Non-HTTP (a socket, a job) has no header to negotiate; it speaks current.
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
    // Always echoed, including when defaulted, so a caller knows which shape it got.
    response.setHeader(this.options.header, version);

    // Common case: no shape lookup, no copy, no `map` on the response stream.
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
      // No header means the newest shape.
      return this.options.changeset.latest;
    }

    try {
      return this.options.changeset.parse(requested.trim());
    } catch (error) {
      if (error instanceof UnknownVersion) {
        // A 400 rather than silently serving a different version than asked for.
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
      // The page wrapper is not a versioned shape, only its contents; rebuild it.
      return { ...body, items: body.items.map(down) };
    }

    return down(body);
  }
}

/** An object a transform can work on. Arrays are excluded; the interceptor unwraps them first. */
function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
