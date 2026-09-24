import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
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

/** Translates domain errors into HTTP; the only place that knows both vocabularies. */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter<DomainError> {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    // Non-HTTP handlers report failures their own way.
    if (host.getType() !== 'http') throw error;

    const status = statusFor(error);
    // A described failure (`DependencyUnavailable`) logs as a line with its
    // cause; anything else reaching a 5xx logs with its stack.
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
  // Request was well formed; a dependency would not play its part.
  if (error instanceof DependencyUnavailable) return HttpStatus.SERVICE_UNAVAILABLE;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return cause === undefined ? 'no cause recorded' : String(cause);
}
