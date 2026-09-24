/**
 * What the suite must not inherit from whoever runs it.
 *
 * Bun loads `apps/ingot/.env` automatically, which is right for `bun run dev`
 * and wrong for `bun run test`: a configured model would make the suite embed
 * and summarise over the network. Preloaded via `bunfig.toml`, before any test
 * file reads the environment.
 */

/** Pin the offline stand-ins, so the whole pipeline runs with no network or key. */
process.env.INGOT_EMBEDDER = 'local';
process.env.INGOT_SUMMARISER = 'local';

/*
 * The background is not switched off here, and there is no environment variable
 * that would: `makeWorld` overrides `BackgroundWork`, and `compileAppModule`
 * empties the scheduler's tickers.
 */
