import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { PgEmbedBudget } from '../../src/contexts/records/infrastructure/postgres/pg-embed-budget.js';
import { closeDatabase, openDatabase, testUnitOfWork } from '../support/database.js';

/** The embedder's quota as every replica sees it: one row both write. */

const start = Date.parse('2026-10-23T12:00:00Z');
const at = (ms: number) => new Date(start + ms);

async function budget(tpm: number | null): Promise<PgEmbedBudget> {
  return new PgEmbedBudget(await testUnitOfWork(), tpm);
}

beforeEach(async () => {
  const { pool } = await openDatabase();
  await pool.query('DELETE FROM embed_budget');
});

afterAll(closeDatabase);

describe('PgEmbedBudget', () => {
  it('shares one window between replicas and opens the next a minute later', async () => {
    const [one, two] = [await budget(10_000), await budget(10_000)];
    expect(await one.reserve(6_000, at(0))).toBe(true);
    expect(await two.reserve(6_000, at(1_000))).toBe(false);
    expect(await two.reserve(4_000, at(1_000))).toBe(true);
    expect(await one.reserve(6_000, at(60_000))).toBe(true);
  });

  it('lets one request bigger than the whole budget into an empty window', async () => {
    const small = await budget(1_000);
    expect(await small.reserve(5_000, at(0))).toBe(true);
    expect(await small.reserve(1, at(1_000))).toBe(false);
  });

  it('pauses every replica, and a shorter pause never cuts a longer one', async () => {
    const [one, two] = [await budget(null), await budget(null)];
    await one.pause(at(60_000));
    await two.pause(at(10_000));
    expect(await two.paused(at(30_000))).toBe(true);
    expect(await two.reserve(1, at(30_000))).toBe(false);
    expect(await two.paused(at(60_000))).toBe(false);
    expect(await two.reserve(1, at(60_000))).toBe(true);
  });

  it('has no ceiling without a budget', async () => {
    const open = await budget(null);
    expect(await open.reserve(1_000_000, at(0))).toBe(true);
    expect(await open.reserve(1_000_000, at(1))).toBe(true);
  });
});
