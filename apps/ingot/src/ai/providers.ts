/**
 * Who does the thinking.
 *
 * Two ports use this — `Embedder` turns text into vectors, `Summariser` writes
 * a précis of a stored tool result — and they are selected *independently*,
 * from the same set. That is deliberate: wanting real semantic search is not
 * the same as wanting an LLM call on every receipt, and one env var for both
 * would make the cheap half impossible to have without the expensive one.
 *
 * `EMBEDDERS` and `SUMMARISERS` in `ai.module.ts` are `Record`s over this
 * enum, so a provider added here without both adapters fails to compile.
 */
export enum AiProvider {
  /**
   * Offline stand-ins: a hashed bag of words, and an extractive summary.
   *
   * The default, and not an apology for one. A hosted model needs a network,
   * a key and a bill, and none of those should be required to run the suite
   * or to try the product on a laptop. Both stand-ins say so at boot.
   */
  Local = 'local',
  /** OpenAI, or anything that speaks its API — `OPENAI_BASE_URL` retargets it. */
  OpenAi = 'openai',
  /** Google Vertex AI, held by Application Default Credentials. */
  Gcp = 'gcp',
}
