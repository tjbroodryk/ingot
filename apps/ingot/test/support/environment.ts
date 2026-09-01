/**
 * What the suite must not inherit from whoever is running it.
 *
 * Bun loads `apps/ingot/.env` automatically, which is right for `bun run dev`
 * and wrong for `bun run test`: a developer who has configured a real model
 * would have the suite embed and summarise through it. That is a test run that
 * needs a network, needs credentials, **costs money**, and gives a different
 * answer on their machine than on anybody else's — including CI, where it
 * simply fails.
 *
 * It is the same argument `makeWorld` already makes about the base tier — "a
 * developer with a bucket in their own environment does not change what the
 * suite writes" — and it belongs here rather than there because the two tests
 * that compile the real `AppModule` never go through `makeWorld` at all.
 *
 * Preloaded via `bunfig.toml`, so this runs before any test file is imported
 * and therefore before any module reads the environment.
 */

/**
 * The offline stand-ins, always.
 *
 * `HashEmbedder` and `ExtractiveSummariser` exist so that the whole pipeline —
 * the queue, the lease, the sibling Parquet, the roll-up, the ranking SQL —
 * can be exercised with no network, no key and no bill. A suite that silently
 * used a hosted model instead would be asserting on somebody's billing
 * account. A test that wants a real one injects it, as
 * `receipt-transaction.test.ts` does.
 */
process.env.INGOT_EMBEDDER = 'local';
process.env.INGOT_SUMMARISER = 'local';

/*
 * Durable sends are not switched off here, and there is no environment
 * variable that would. `RESTATE_ENABLED=false` used to live in this file and
 * nowhere else, which made a test-only convenience look like a supported
 * deployment — two sweepers cited it in their comments as the topology they
 * existed to cover. A test that must not POST at whatever ingress happens to
 * be running on this machine overrides `RestateIngress`, which `makeWorld`
 * does for every world it builds.
 */
