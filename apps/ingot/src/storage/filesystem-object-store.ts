import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { ObjectStore, PendingWrite } from './object-store.port.js';

/**
 * The base tier on local disk.
 *
 * The default, and not merely a test double: a single-node deployment with a
 * volume is a perfectly good way to run this, and making the local path a
 * first-class adapter means the code that reads Parquet is the same code in
 * both compositions. The alternative — S3 in production, something else in
 * development — is how a bug that only exists in one of them gets written.
 */
@Injectable()
export class FilesystemObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  uri(key: string): string {
    return this.pathFor(key);
  }

  async session(): Promise<readonly string[]> {
    return [];
  }

  async beginWrite(key: string): Promise<PendingWrite> {
    const path = this.pathFor(key);
    // DuckDB's COPY … TO writes the file but will not create its directory.
    await mkdir(dirname(path), { recursive: true });

    return {
      target: path,
      // DuckDB wrote the object itself, in place. There is no second step,
      // and a generation is only ever read once the manifest names it — so a
      // file left behind by a write that failed is invisible rather than
      // half-published, and `discard` removing it is tidiness, not safety.
      commit: async () => {},
      discard: async () => {
        await rm(path, { force: true });
      },
    };
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async fetch(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    try {
      return { bytes: (await stat(this.pathFor(key))).size };
    } catch {
      return null;
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(this.pathFor(key), { force: true })));
  }

  async removePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  describe(): string {
    return `the filesystem at ${this.root}`;
  }

  /**
   * Resolves a key under the root, and refuses one that escapes it.
   *
   * Keys are built by `Keys` from ids this service generated, so `..` should
   * never appear — which is exactly why the check is cheap to keep. A path
   * traversal here would be a write anywhere the process can reach.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(`${this.root}/`)) {
      throw new Error(`Object key "${key}" resolves outside the store root`);
    }
    return path;
  }
}
