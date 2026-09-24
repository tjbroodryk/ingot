import { Injectable, type NestMiddleware } from '@nestjs/common';
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { Metrics } from '../metrics/catalogue.js';
import { markFailed, tracer } from '../tracing/tracer.js';

/**
 * The root span and the request metric for every HTTP request.
 *
 * Middleware rather than an interceptor so refused requests (401, 403, 404)
 * are counted too. The span is opened active around `next()`, so every command,
 * query and `observe()` below becomes a descendant of it.
 */
@Injectable()
export class TelemetryMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const method = request.method;
    const started = process.hrtime.bigint();

    Metrics.HttpRequestsInFlight.inc({ method });

    // Continues the caller's trace when it sent a `traceparent` header.
    const incoming = propagation.extract(context.active(), request.headers);

    context.with(incoming, () => {
      const span = tracer().startSpan(
        // Renamed at finish, once the route template is known.
        `${method} ${request.path}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': method,
            'url.path': request.path,
            'url.query': request.url.split('?')[1] ?? '',
            'user_agent.original': request.get('user-agent') ?? '',
          },
        },
        incoming,
      );

      const finish = (): void => {
        response.removeListener('finish', finish);
        response.removeListener('close', finish);

        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const status = response.statusCode;
        const route = routeTemplate(request);

        span.updateName(`${method} ${route}`);
        span.setAttributes({ 'http.route': route, 'http.response.status_code': status });

        // 5xx marks the span failed; 4xx is the caller's fault, not an error here.
        if (status >= 500) markFailed(span, new Error(`HTTP ${status}`));

        Metrics.HttpRequestsInFlight.dec({ method });
        Metrics.HttpRequestDuration.observe({ method, route, status: String(status) }, seconds);
        span.end();
      };

      // `finish` for a response that was sent, `close` for a client that hung
      // up mid-response; without the second, an aborted request leaks a span.
      response.once('finish', finish);
      response.once('close', finish);

      context.with(trace.setSpan(context.active(), span), next);
    });
  }
}

/**
 * The route template as Express matched it (`/api/v1/:account/:ingot/query`), not
 * the resolved path; keeps the metric's cardinality bounded. Unmatched paths
 * collapse to a single `unmatched` series.
 */
function routeTemplate(request: Request): string {
  const matched = (request.route as { path?: string } | undefined)?.path;
  if (!matched) return 'unmatched';
  return `${request.baseUrl ?? ''}${matched}`.replace(/\/+/g, '/') || '/';
}
