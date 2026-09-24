import { EmbedWorker } from '../contexts/records/application/embed-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/** Embeds overlay rows whose text has no vector yet. */
@Cron({
  name: 'sweep-embeddings',
  everyMs: EVERY,
  description: 'Embeds overlay rows whose text has no vector yet',
})
export class EmbeddingsSweeper {
  constructor(private readonly worker: EmbedWorker) {}

  async tick(): Promise<void> {
    // Keep draining while the queue outlasts a single bounded drain, up to one interval.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
