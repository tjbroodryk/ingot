import { FileWorker } from '../contexts/files/application/file-worker.js';
import { Cron, minutes } from './cron.js';
import { drainWithin } from './drain-within.js';

const EVERY = minutes(1);

/** Parses uploaded documents `/file` accepted and has not turned into chunks yet. */
@Cron({
  name: 'sweep-files',
  everyMs: EVERY,
  description: 'Parses uploaded documents into chunks and extracted rows',
})
export class FilesSweeper {
  constructor(private readonly worker: FileWorker) {}

  async tick(): Promise<void> {
    // Keep draining while the queue outlasts a single bounded drain, up to one interval.
    await drainWithin(EVERY, () => this.worker.drain());
  }
}
