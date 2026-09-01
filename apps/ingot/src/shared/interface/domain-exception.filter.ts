import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ActionNotPermitted,
  AggregateNotFound,
  AuthenticationFailed,
  ConflictingState,
  DependencyUnavailable,
  DomainError,
  InvariantViolation,
} from '../domain/index.js';

/**
 * Translates domain errors into HTTP. This is the only place that knows both
 * vocabularies, which is what lets the domain raise `ActionNotPermitted`
 * without ever importing a status code.
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter<DomainError> {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    // WebSocket handlers report failures in their own acknowledgement, so
    // reaching for an HTTP response here would throw over the real error.
    if (host.getType() !== 'http') throw error;

    const status = statusFor(error);
    /*
     * A described failure is logged as a line; an undescribed one is logged as
     * a crash.
     *
     * `DependencyUnavailable` already says what happened in a sentence written
     * to be read, and our stack through it is the least interesting part —
     * what an operator wants is the cause, which is why it is on `cause`
     * rather than in the message. Everything else reaching a 5xx here is
     * something we did not anticipate, and for those the stack is the point.
     */
    if (error instanceof DependencyUnavailable) {
      this.logger.warn(`${error.message} (${describe(error.cause)})`);
    } else if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(error.message, error.stack);
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.status(status).json({
      statusCode: status,
      error: error.code,
      message: error.message,
    });
  }
}

function statusFor(error: DomainError): number {
  if (error instanceof AuthenticationFailed) return HttpStatus.UNAUTHORIZED;
  if (error instanceof AggregateNotFound) return HttpStatus.NOT_FOUND;
  if (error instanceof ActionNotPermitted) return HttpStatus.FORBIDDEN;
  if (error instanceof ConflictingState) return HttpStatus.CONFLICT;
  if (error instanceof InvariantViolation) return HttpStatus.UNPROCESSABLE_ENTITY;
  // Nothing is wrong *here*: the request was well formed and we could not
  // carry it out because something we depend on would not play its part.
  if (error instanceof DependencyUnavailable) return HttpStatus.SERVICE_UNAVAILABLE;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return cause === undefined ? 'no cause recorded' : String(cause);
}

export { HttpException };
