import { describe, expect, it } from 'bun:test';
import { EnvMisconfigured, loadSection } from '../../src/config/env.js';
import {
  DEFAULT_ROLL_UP_CONCURRENCY,
  DEFAULT_ROLL_UP_INTERVAL_MS,
  DEFAULT_ROLL_UP_MIN_ROWS,
  rollUpEnv,
} from '../../src/contexts/records/application/roll-up-settings.js';

const rollUpFrom = (source: Record<string, string>) => loadSection(rollUpEnv, source);

describe('the roll-up settings', () => {
  it('falls back to a thousand rows, five minutes and four at once', () => {
    expect(rollUpFrom({})).toEqual({
      minRows: DEFAULT_ROLL_UP_MIN_ROWS,
      intervalMs: DEFAULT_ROLL_UP_INTERVAL_MS,
      concurrency: DEFAULT_ROLL_UP_CONCURRENCY,
    });
    expect([
      DEFAULT_ROLL_UP_MIN_ROWS,
      DEFAULT_ROLL_UP_INTERVAL_MS,
      DEFAULT_ROLL_UP_CONCURRENCY,
    ]).toEqual([1_000, 300_000, 4]);
  });

  it('reads all three', () => {
    expect(
      rollUpFrom({
        INGOT_ROLLUP_MIN_ROWS: '50',
        INGOT_ROLLUP_INTERVAL_MS: '120000',
        INGOT_ROLLUP_CONCURRENCY: '12',
      }),
    ).toEqual({ minRows: 50, intervalMs: 120_000, concurrency: 12 });
  });

  it('refuses an interval under a minute', () => {
    expect(() => rollUpFrom({ INGOT_ROLLUP_INTERVAL_MS: '30000' })).toThrow(EnvMisconfigured);
  });

  it('refuses a row count of zero', () => {
    expect(() => rollUpFrom({ INGOT_ROLLUP_MIN_ROWS: '0' })).toThrow(EnvMisconfigured);
  });

  it('refuses more compactions at once than a batch holds', () => {
    expect(() => rollUpFrom({ INGOT_ROLLUP_CONCURRENCY: '26' })).toThrow(EnvMisconfigured);
  });
});
