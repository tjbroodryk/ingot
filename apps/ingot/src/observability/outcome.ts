/**
 * How a measured operation ended.
 *
 * Every duration histogram in the catalogue carries this, and it is always the
 * last label, because the difference between "p99 is fine" and "p99 is fine
 * for the requests that worked" is the single most common way a latency
 * dashboard lies. An operation that throws is still an operation that took
 * time, so it is recorded rather than dropped — under a label that lets a
 * query exclude it.
 */
export enum Outcome {
  Ok = 'ok',
  Error = 'error',
}
