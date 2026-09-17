/**
 * Everything this SDK throws on purpose.
 *
 * `status` is the HTTP status when there was a response, and 0 when there was
 * not — a network failure, a timeout, or a check made before sending.
 * `code` is the server's `error` field when it gave one.
 */
export class IngotError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? 0;
    this.code = options.code ?? (this.status > 0 ? String(this.status) : 'client');
  }
}

/** 401: the key is missing, malformed or revoked. */
export class AuthenticationError extends IngotError {}
/** 403: the key is valid, but not for this account. */
export class PermissionError extends IngotError {}
/** 404: no such memory, table or key — or it expired. */
export class NotFoundError extends IngotError {}
/** 409: the request raced something, or the state it expects moved on. */
export class ConflictError extends IngotError {}
/** 410: a Parquet generation that has been reaped. Read `/pending` again. */
export class GoneError extends IngotError {}
/** 400 or 422: the request was understood and refused. The message says why. */
export class ValidationError extends IngotError {}
/** 503: something the server depends on is down. Safe calls are retried. */
export class UnavailableError extends IngotError {}
/** No response at all: DNS, refused connection, TLS, CORS. */
export class ConnectionError extends IngotError {}
/** No response within `timeoutMs`, or a wait that ran out. */
export class TimeoutError extends IngotError {}
/** The client was constructed without something it needs. */
export class ConfigurationError extends IngotError {}

/** A webhook or queue body whose `event` this SDK does not know. Safe to ignore. */
export class UnknownDeliveryEventError extends IngotError {
  readonly event: string;

  constructor(event: string) {
    super(`Unknown delivery event "${event}"`, { code: 'unknown_delivery_event' });
    this.event = event;
  }
}

/** An MCP tool that ran and reported failure. The message is the server's. */
export class McpToolError extends IngotError {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super(message, { code: 'tool_error' });
    this.tool = tool;
  }
}

/** The server's error envelope, parsed as far as it can be. */
export function errorFromResponse(status: number, statusText: string, body: unknown): IngotError {
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message =
    messageOf(envelope.message) ?? (`${status} ${statusText}`.trim() || 'Request failed');
  const code = typeof envelope.error === 'string' ? envelope.error : String(status);
  const options = { status, code };

  switch (status) {
    case 400:
    case 422:
      return new ValidationError(message, options);
    case 401:
      return new AuthenticationError(message, options);
    case 403:
      return new PermissionError(message, options);
    case 404:
      return new NotFoundError(message, options);
    case 409:
      return new ConflictError(message, options);
    case 410:
      return new GoneError(message, options);
    case 503:
      return new UnavailableError(message, options);
    default:
      return new IngotError(message, options);
  }
}

function messageOf(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw.map(String).join('; ');
  return null;
}
