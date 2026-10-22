import { describe, expect, it } from 'bun:test';
import type { Embedder } from '../../src/ai/embedder.port.js';
import { RemoteModelError } from '../../src/ai/remote.js';
import { ClaimEmbeddings } from '../../src/contexts/records/application/commands/claim-embeddings.command.js';
import { ReleaseEmbeddings } from '../../src/contexts/records/application/commands/release-embeddings.command.js';
import { SaveEmbeddings } from '../../src/contexts/records/application/commands/save-embeddings.command.js';
import {
  EMBED_REQUEST_TOKENS,
  EmbedWorker,
  estimateTokens,
  packByTokens,
} from '../../src/contexts/records/application/embed-worker.js';
import type { PendingEmbedding } from '../../src/contexts/records/application/ports/overlay-store.port.js';
import type { Dispatcher } from '../../src/shared/application/index.js';

/**
 * A batch the embedder's quota can never fit stops the queue for good: the
 * request is refused, handed back, and claimed again unchanged a minute later.
 * So requests are bounded by tokens, what succeeded is kept, and a rate limit
 * is waited out rather than hammered.
 */

const row = (id: number, bytes: number): PendingEmbedding => ({
  tableId: 'tbl',
  rowId: `row_${id}`,
  column: 'text',
  text: 'x'.repeat(bytes),
});

describe('packByTokens', () => {
  it('keeps order and stays under the budget', () => {
    // 1,000 estimated tokens each, and 100 for the last.
    const rows = [row(1, 3_000), row(2, 3_000), row(3, 3_000), row(4, 300)];
    const requests = packByTokens(rows, 2_000);
    expect(requests.map((request) => request.map((entry) => entry.rowId))).toEqual([
      ['row_1', 'row_2'],
      ['row_3', 'row_4'],
    ]);
  });

  it('sends a text over budget on its own rather than never', () => {
    expect(packByTokens([row(1, 90_000), row(2, 10)], 1_000)).toHaveLength(2);
  });

  it('overestimates from bytes, whatever the script', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('é'.repeat(3))).toBe(2);
  });
});

describe('EmbedWorker', () => {
  // Two requests' worth: each row is about 4k estimated tokens.
  const claimed = Array.from({ length: 8 }, (_, at) => row(at, 12_000));

  function world(fail: (request: number) => Error | null) {
    const saved: string[] = [];
    const released: string[] = [];
    let requests = 0;
    const now = { ms: Date.parse('2026-10-22T12:00:00Z') };
    // The queue: whatever has not been saved yet, as a claim would see it.
    const dispatcher = {
      async send(command: unknown) {
        if (command instanceof ClaimEmbeddings) {
          return claimed.filter((entry) => !saved.includes(entry.rowId));
        }
        if (command instanceof ReleaseEmbeddings) {
          released.push(...command.entries.map((entry) => entry.rowId));
          return undefined;
        }
        if (command instanceof SaveEmbeddings) {
          saved.push(...command.embedded.map((entry) => entry.rowId));
          return command.embedded.length;
        }
        throw new Error(`unexpected ${String(command)}`);
      },
    } as unknown as Dispatcher;
    const embedder: Embedder = {
      model: 'test',
      dimensions: 2,
      async embed(texts) {
        const total = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
        expect(total).toBeLessThanOrEqual(EMBED_REQUEST_TOKENS);
        const error = fail(requests++);
        if (error) throw error;
        return texts.map(() => [0, 1]);
      },
    };
    const worker = new EmbedWorker(dispatcher, embedder, { now: () => new Date(now.ms) });
    return { worker, saved, released, now, calls: () => requests };
  }

  it('splits a claim into requests the quota can fit', async () => {
    const { worker, saved, calls } = world(() => null);
    expect(await worker.next()).toBe(8);
    expect(saved).toHaveLength(8);
    expect(calls()).toBeGreaterThan(1);
  });

  it('keeps what was embedded when a later request fails', async () => {
    const { worker, saved, released } = world((request) =>
      request === 1 ? new RemoteModelError('openai', 500, 'boom') : null,
    );
    await expect(worker.next()).rejects.toThrow('boom');
    expect(saved.length).toBeGreaterThan(0);
    expect([...saved, ...released].sort()).toEqual(claimed.map((entry) => entry.rowId).sort());
  });

  it('waits out a rate limit instead of asking again inside the window', async () => {
    const { worker, now, calls } = world((request) =>
      request === 0 ? new RemoteModelError('openai', 429, 'slow down') : null,
    );
    await expect(worker.drain()).rejects.toThrow('slow down');
    expect(await worker.drain()).toEqual({ done: 0, more: false });
    expect(calls()).toBe(1);

    now.ms += 61_000;
    await worker.drain();
    expect(calls()).toBeGreaterThan(1);
  });
});
