import { describe, expect, it } from 'bun:test';
import { loadSection } from '../../src/config/env.js';
import { engineEnv } from '../../src/engine/engine-settings.js';
import { WarmSessions } from '../../src/engine/warm-sessions.js';

const warmSessions = (raw: string | undefined) =>
  loadSection(engineEnv, { INGOT_QUERY_WARM_SESSIONS: raw }).warmSessions;

function fake() {
  let opened = 0;
  const closed: number[] = [];
  let failNext = false;
  const open = async () => {
    if (failNext) {
      failNext = false;
      throw new Error('no extension directory');
    }
    const id = ++opened;
    return { id, close: () => closed.push(id) };
  };
  return {
    open,
    closed,
    get opened() {
      return opened;
    },
    failOnce: () => {
      failNext = true;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('warm sessions', () => {
  it('fills to its size and replaces each one taken', async () => {
    const sessions = fake();
    const pool = new WarmSessions(2, sessions.open);
    pool.start();
    await settle();
    expect(pool.available).toBe(2);

    expect(pool.take()).toBeDefined();
    await settle();
    expect(pool.available).toBe(2);
    expect(sessions.opened).toBe(3);
    pool.close();
  });

  it('never hands out the same session twice', async () => {
    const pool = new WarmSessions(3, fake().open);
    pool.start();
    await settle();
    const taken = [pool.take(), pool.take(), pool.take()].map((session) => session?.id);
    expect(new Set(taken).size).toBe(3);
    pool.close();
  });

  // An empty pool is the caller opening its own, which is what 0 means.
  it('gives nothing when empty or sized 0', async () => {
    const sessions = fake();
    const pool = new WarmSessions(0, sessions.open);
    pool.start();
    await settle();
    expect(pool.take()).toBeUndefined();
    expect(sessions.opened).toBe(0);
  });

  it('closes what is idle, and what finishes opening after it shut', async () => {
    const sessions = fake();
    const pool = new WarmSessions(2, sessions.open);
    pool.start();
    await settle();
    const taken = pool.take();
    pool.close();
    await settle();
    // The idle one at once, the taken one's replacement as it landed. The taken
    // one is its user's to close.
    expect(taken?.id).toBe(2);
    expect(sessions.closed).toEqual([1, 3]);
    expect(pool.available).toBe(0);
  });

  it('does not retry a failed open until the next take', async () => {
    const sessions = fake();
    sessions.failOnce();
    const pool = new WarmSessions(1, sessions.open);
    pool.start();
    await settle();
    expect(pool.available).toBe(0);
    expect(sessions.opened).toBe(0);

    expect(pool.take()).toBeUndefined();
    await settle();
    expect(pool.available).toBe(1);
    pool.close();
  });
});

describe('INGOT_QUERY_WARM_SESSIONS', () => {
  it('defaults when unset or blank', () => {
    expect(warmSessions(undefined)).toBe(2);
    expect(warmSessions(' ')).toBe(2);
  });

  it('takes 0 to mean on demand', () => {
    expect(warmSessions('0')).toBe(0);
  });

  it('refuses what is not a small whole number', () => {
    for (const raw of ['-1', '1.5', 'two', '200']) {
      expect(() => warmSessions(raw)).toThrow('INGOT_QUERY_WARM_SESSIONS');
    }
  });
});
