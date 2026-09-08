import { BenchmarksPage, benchmarksMetadata } from '../../benchmarks/benchmarks-page';

/**
 * `/benchmarks` in a landing build.
 *
 * Landing only, for the reason `/why` and `/deployment` are: a dashboard build
 * is the site that ships beside a running service, and a reader looking at it
 * is past the question of whether the retrieval is any good — they are using
 * it. The numbers belong in front of the project, not inside it.
 */
export const metadata = benchmarksMetadata;

export default BenchmarksPage;
