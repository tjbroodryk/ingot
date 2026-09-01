import { Injectable, type NestMiddleware } from '@nestjs/common';
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { Metrics } from '../metrics/catalogue.js';
import { markFailed, tracer } from '../tracing/tracer.js';

/**
 * The root span and the request metric for every HTTP request.
 *
 * Middleware rather than a Nest interceptor, and the reason is the requests an
 * interceptor never sees. Nest runs middleware → guards → interceptors, so a
 * request refused by `AccessTokenGuard` or `ScopeGuard` is finished before any
 * interceptor is entered — and 401s and 403s are precisely the traffic you go
 * looking for. Same for a 404, which never reaches a controller at all. From
 * here, everything that arrives is counted, whatever became of it.
 *
 * The span is opened *active* around `next()`, which is what makes every
 * command, query and `observe()` further in a descendant of it with no
 * plumbing: one trace per request, from the first byte to the last.
 */
@Injectable()
export class TelemetryMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const method = request.method;
    const started = process.hrtime.bigint();

    Metrics.HttpRequestsInFlight.inc({ method });

    /**
     * Continues the caller's trace when it sent one.
     *
     * A `traceparent` header means this request is already part of somebody
     * else's story — a browser that started the trace on a click, or another
     * service calling in. Extracting it is the difference between one trace
     * spanning the whole interaction and a pile of unrelated ones.
     */
    const incoming = propagation.extract(context.active(), request.headers);

    context.with(incoming, () => {
      const span = tracer().startSpan(
        // Renamed at finish, once the route template is known. Until routing
        // has happened there is nothing to name it but the raw URL, and that
        // is the one name it must never keep.
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

        // 5xx is the server's fault and belongs in an error rate; 4xx is the
        // caller's and does not. Marking every non-2xx as an error is how a
        // trace view fills with red that nobody is meant to act on.
        if (status >= 500) markFailed(span, new Error(`HTTP ${status}`));

        Metrics.HttpRequestsInFlight.dec({ method });
        Metrics.HttpRequestDuration.observe({ method, route, status: String(status) }, seconds);
        span.end();
      };

      // `finish` for a response that was sent, `close` for a client that hung
      // up mid-response. Without the second, an aborted request leaks a span
      // and a point on the in-flight gauge that never comes back down.
      response.once('finish', finish);
      response.once('close', finish);

      context.with(trace.setSpan(context.active(), span), next);
    });
  }
}

/**
 * The route as Express matched it — `/api/v1/projects/:projectId/repos` — not
 * as the caller wrote it.
 *
 * This is the single most important line in the file. `route` labels a metric,
 * and a metric labelled with resolved paths has one time series per project
 * id: the cardinality grows with the data, the store falls over, and it does
 * so gradually enough that nobody connects it to this decision.
 *
 * Anything unmatched collapses to one series for the same reason. A scanner
 * walking `/wp-admin`, `/.env` and ten thousand other paths is a 404 counter,
 * not ten thousand of them.
 */
function routeTemplate(request: Request): string {
  const matched = (request.route as { path?: string } | undefined)?.path;
  if (!matched) return 'unmatched';
  return `${request.baseUrl ?? ''}${matched}`.replace(/\/+/g, '/') || '/';
}
