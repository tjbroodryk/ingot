/**
 * Errors the domain raises on its own terms. They carry no HTTP status — the
 * interface layer maps them (see `DomainExceptionFilter`), which keeps the
 * domain free of transport concerns.
 */
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

/**
 * We could not establish who is calling at all — no credential, or one that
 * does not check out.
 *
 * The distinction from `ActionNotPermitted` is the one between 401 and 403,
 * and it is worth keeping sharp: this means "log in", that means "we know who
 * you are and the answer is still no".
 */
export class AuthenticationFailed extends DomainError {
  readonly code = 'authentication_failed';
}

/** The actor is known but not permitted to perform this action. */
export class ActionNotPermitted extends DomainError {
  readonly code = 'action_not_permitted';
}

/**
 * Something this product depends on could not do its job.
 *
 * Distinct from every error above it, which are all *our* answers about our own
 * state: this one is a report about somebody else's. The distinction earns its
 * place at the edge, where an anonymous 500 and a described 503 read very
 * differently — "Could not set up Ledger API" tells a reader nothing they can
 * act on, and "the agent runner rejected the request, so nothing was created"
 * tells them what happened, what it cost them, and whether pressing the button
 * again is worth anything.
 *
 * So the message on one of these is user-facing prose, not a stack. Where the
 * failure came from is `dependency`, and the underlying error goes on `cause`
 * for the log — the reader gets the sentence, the operator gets the detail.
 */
export class DependencyUnavailable extends DomainError {
  readonly code = 'dependency_unavailable';

  constructor(
    /** What let us down, in this product's words — `agent runner`, not a URL. */
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
