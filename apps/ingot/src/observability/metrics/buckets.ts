/**
 * Bucket sets, named for the thing being timed.
 *
 * Buckets are the one decision a histogram cannot walk back. They are fixed at
 * declaration and Prometheus only knows what fell in which — so a set whose
 * boundaries are all above the real latency gives a p99 of "less than the
 * first bucket", and one whose boundaries are all below gives `+Inf`. Both are
 * useless, and you find out weeks later when you need the number.
 *
 * Hence a small vocabulary rather than a free choice per metric: three or four
 * shapes cover everything this service does, and reusing one means the
 * boundaries line up across metrics, which is what lets a single Grafana panel
 * overlay command latency against the HTTP latency that contains it.
 *
 * Every value is seconds.
 */
export const Buckets = {
  /**
   * Anything answering a browser. Wide on purpose: the interesting failures at
   * the top end are the requests a user gave up on, and clipping them at one
   * second hides exactly those.
   */
  Request: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const,

  /**
   * In-process work with no network in it — a transaction, a projector, a
   * domain service. Tighter and lower, because a p99 of 40ms and a p99 of
   * 400ms are the same bucket under `Request` and are not the same problem.
   */
  Internal: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5] as const,

  /**
   * Calls to somebody else's service — GitHub, WorkOS, the vector store.
   * Stretched to 30s because a code host under load is slow long before it is
   * down, and the shape of that tail is the argument for a circuit breaker.
   */
  Upstream: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const,

  /**
   * Queue-ish latencies measured from when something was recorded to when it
   * was finally dealt with. Starts near zero and runs to minutes, because the
   * whole point of watching it is spotting the transition from "prompt" to
   * "backlogged".
   */
  Lag: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300] as const,
} as const;
