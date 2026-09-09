import { FileWorker } from '../contexts/files/application/file-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/**
 * Reads the documents `/file` accepted and has not turned into chunks yet.
 *
 * The same two ways in as every other queue, for the same reasons. `/file`
 * wakes the worker on commit, so somebody who has just uploaded a document gets
 * it parsed about as fast as it can be parsed rather than within the minute;
 * this tick is the floor under a wake that never arrived, and there are two
 * ways for that — the process can die between the COMMIT and the wake, and a
 * drain can throw halfway through a backlog.
 *
 * Nothing here is a second read path: `FileWorker` is the only thing in the
 * service that turns bytes into chunks, and both ways in call its `drain`.
 * Concurrent arrivals are safe because a claim takes a lease — a woken pass and
 * a tick take different documents rather than parsing the same one twice and
 * writing its chunks in duplicate.
 */
@Cron({
  name: 'sweep-files',
  everyMs: EVERY,
  description: 'Parses uploaded documents into chunks and extracted rows',
})
export class FilesSweeper {
  constructor(private readonly worker: FileWorker) {}

  async tick(): Promise<void> {
    // Not one drain: a worker bounds each drain so it yields, and a tick that
    // called it once would turn that yield point into a rate limit of two
    // documents a minute. `drainWithin` keeps going while the queue outlasts a
    // drain, and stops at the moment the next tick would have started.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
