/**
 * How long a claim holds background work before another worker may take it.
 *
 * A lease rather than a row lock, because none of the three queues does its
 * work inside the transaction that claimed it — a model is an HTTP round trip
 * and so is a webhook, and holding a Postgres connection across one spends a
 * pool of ten on background work while the foreground is trying to answer.
 *
 * The number has one requirement, and it is the reason this constant lives in
 * `shared/` rather than beside the queue that first needed it: **it must be
 * comfortably longer than any call a worker makes while holding a claim.** A
 * lease that lapses mid-call is a second replica taking work the first is still
 * doing — which for embedding is a wasted call, and for delivery is a receiver
 * told twice about the same receipt. Beyond that, longer is only slower to
 * recover from a worker that died mid-call.
 *
 * `MAX_UPSTREAM_TIMEOUT_MS` is that requirement made checkable, and both
 * settings modules hold their timeouts to it at boot.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * The longest a configured timeout may be, given the lease above.
 *
 * Half, rather than all of it, and the margin is doing real work: a worker
 * still has to write the outcome after its call returns, and the claim it is
 * holding has to survive both. A timeout equal to the lease would mean the
 * lease lapsing at the same instant the call gives up, which is the race this
 * exists to prevent rather than a bound on it.
 *
 * Nothing was checking this before. `INGOT_AI_TIMEOUT_MS` and
 * `INGOT_DELIVERY_TIMEOUT_MS` are both operator-settable with no upper bound,
 * so a deployment could set either past the lease and turn at-least-once
 * delivery into reliably-twice — silently, and only under enough replicas to
 * make the second claim likely.
 */
export const MAX_UPSTREAM_TIMEOUT_MS = CLAIM_LEASE_MS / 2;

/**
 * Why a timeout is too long, or null when it is fine.
 *
 * A message rather than a throw, because the two callers raise different
 * errors — `AiMisconfigured` and `DeliveryMisconfigured` — and which one a
 * deployment sees should say which half of the configuration to go and look at.
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
