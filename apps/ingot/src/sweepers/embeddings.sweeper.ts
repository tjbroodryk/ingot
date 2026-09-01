import { EmbedWorker } from '../contexts/records/application/embed-worker.js';
import { Cron, minutes } from './cron.js';

const EVERY = minutes(1);

/**
 * Embeds whatever `/add` queued.
 *
 * Two ways in, and they matter for different reasons.
 *
 * `/add` wakes `EmbedWorker.drain` the moment its transaction commits, so a row
 * becomes findable by meaning in about as long as the model takes rather than
 * in up to a minute. That minute was latency a caller experienced for no reason
 * — the work was known about the instant it was queued.
 *
 * This tick is the floor, and is not redundant. It covers the wake that never
 * happened: a process that dies between the COMMIT and the call, and a drain
 * that throws part-way through a backlog. Both leave rows queued with nobody
 * told, and both are found here.
 *
 * The two cannot disagree about what a pass is, because both call the same
 * `drain`. Neither has to care about the other arriving at once, because the
 * claim leases its rows with `FOR UPDATE SKIP LOCKED` — a woken drain and a
 * tick running together take different work rather than the same work twice.
 *
 * Silent when nothing moved, which is what keeps a per-write wake and a
 * once-a-minute timer out of the log.
 */
@Cron({
  name: 'sweep-embeddings',
  everyMs: EVERY,
  description: 'Embeds overlay rows whose text has no vector yet',
})
export class EmbeddingsSweeper {
  constructor(private readonly worker: EmbedWorker) {}

  async tick(): Promise<void> {
    await this.worker.drain();
  }
}
