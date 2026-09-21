import { describe, expect, it } from 'bun:test';
import { EnvMisconfigured, loadSection } from '../../src/config/env.js';
import { DEFAULT_MAX_BODY, MAX_BODY_KEY, httpEnv } from '../../src/http/body-limit.js';

const maxBodyBytes = (value: string | undefined) =>
  loadSection(httpEnv, { [MAX_BODY_KEY]: value }).bodyLimit;

describe('the JSON body limit', () => {
  it('is 16 MiB unless set, and an empty variable is unset', () => {
    expect(maxBodyBytes(undefined)).toBe(DEFAULT_MAX_BODY);
    expect(maxBodyBytes('  ')).toBe(DEFAULT_MAX_BODY);
  });

  it('reads bytes, including the float spelling Helm renders them in', () => {
    expect(maxBodyBytes('1048576')).toBe(1_048_576);
    expect(maxBodyBytes('3.3554432e+07')).toBe(33_554_432);
  });

  it.each([['10mb'], ['1.5'], ['1024'], [String(1024 ** 4)]])('refuses %s', (value) => {
    expect(() => maxBodyBytes(value)).toThrow(EnvMisconfigured);
  });
});
