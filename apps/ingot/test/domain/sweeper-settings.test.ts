import { describe, expect, it } from 'bun:test';
import { EnvMisconfigured, loadSection } from '../../src/config/env.js';
import { SweptKind } from '../../src/sweepers/kinds.js';
import { sweepersEnv } from '../../src/sweepers/sweeper-settings.js';

const sweepersFrom = (source: Record<string, string>) => loadSection(sweepersEnv, source);

describe('which sweeps a process runs', () => {
  it('runs every one when nothing is skipped', () => {
    expect(sweepersFrom({}).run).toEqual(Object.values(SweptKind));
  });

  it('leaves out what is skipped', () => {
    const { run } = sweepersFrom({ INGOT_SKIP_SWEEPERS: 'roll_up, Expiry' });
    expect(run).not.toContain(SweptKind.RollUp);
    expect(run).not.toContain(SweptKind.Expiry);
    expect(run).toContain(SweptKind.Embeddings);
  });

  it('refuses a name that is not a sweep', () => {
    expect(() => sweepersFrom({ INGOT_SKIP_SWEEPERS: 'rollup' })).toThrow(EnvMisconfigured);
  });
});
