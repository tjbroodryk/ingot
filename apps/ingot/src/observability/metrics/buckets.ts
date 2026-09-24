/**
 * Histogram bucket sets, named for the thing being timed. Every value is seconds.
 * Reused across metrics so boundaries line up.
 */
export const Buckets = {
  /** Anything answering a browser; wide at the top end. */
  Request: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const,

  /** In-process work with no network in it — a transaction, a projector, a domain service. */
  Internal: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5] as const,

  /** Calls to an external service; stretched to 30s for a slow-but-not-down tail. */
  Upstream: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const,

  /** Queue latency from recorded to handled; near zero to minutes. */
  Lag: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300] as const,
} as const;
