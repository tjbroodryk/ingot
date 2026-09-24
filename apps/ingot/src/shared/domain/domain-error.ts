/** Errors the domain raises on its own terms; they carry no HTTP status. `DomainExceptionFilter` maps them. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An operation would have left an aggregate in an illegal state. */
export class InvariantViolation extends DomainError {
  readonly code = 'invariant_violation';
}

/** The caller asked for an aggregate that does not exist. */
export class AggregateNotFound extends DomainError {
  readonly code = 'aggregate_not_found';

  constructor(
    readonly aggregate: string,
    readonly id: string,
  ) {
    super(`${aggregate} "${id}" does not exist`);
  }
}

/** No credential, or one that does not check out (401, vs `ActionNotPermitted`'s 403). */
export class AuthenticationFailed extends DomainError {
  readonly code = 'authentication_failed';
}

/** The actor is known but not permitted to perform this action. */
export class ActionNotPermitted extends DomainError {
  readonly code = 'action_not_permitted';
}

/**
 * Something this product depends on could not do its job. The message is
 * user-facing prose; `dependency` names the source and `cause` carries the underlying error.
 */
export class DependencyUnavailable extends DomainError {
  readonly code = 'dependency_unavailable';

  constructor(
    /** The source in this product's words, not a URL. */
    readonly dependency: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The action is legal but the aggregate is not in a state that allows it now. */
export class ConflictingState extends DomainError {
  readonly code = 'conflicting_state';
}
