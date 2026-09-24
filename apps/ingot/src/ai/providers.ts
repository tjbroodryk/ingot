/** The provider backing a port. `Embedder` and `Summariser` select independently. */
export enum AiProvider {
  /** Offline stand-ins: a hashed bag of words, and an extractive summary. The default. */
  Local = 'local',
  /** OpenAI, or anything that speaks its API — `OPENAI_BASE_URL` retargets it. */
  OpenAi = 'openai',
  /** Google Vertex AI, held by Application Default Credentials. */
  Gcp = 'gcp',
}
