/**
 * How long a claim holds background work before another worker may take it.
 * Must be comfortably longer than any call a worker makes while holding a claim.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * The longest a configured timeout may be: half the lease, leaving margin to
 * write the outcome before the claim lapses.
 */
export const MAX_UPSTREAM_TIMEOUT_MS = CLAIM_LEASE_MS / 2;

/**
 * Why a timeout is too long, or null when it is fine. Returns a message so each
 * caller raises its own error.
 */
export function tooLongForLease(key: string, timeoutMs: number): string | null {
  if (timeoutMs <= MAX_UPSTREAM_TIMEOUT_MS) return null;

  return (
    `${key} is ${timeoutMs}ms, which is longer than half the ${CLAIM_LEASE_MS}ms lease a ` +
    'worker holds while it makes that call. A call still running when its lease lapses is ' +
    'work a second replica may take up as well — a wasted model call, or a receiver told ' +
    `twice about the same receipt. Keep it at or under ${MAX_UPSTREAM_TIMEOUT_MS}ms.`
  );
}
