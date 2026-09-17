import { describe, expect, it } from 'bun:test';
import {
  BodyLimitMisconfigured,
  DEFAULT_MAX_BODY,
  MAX_BODY_KEY,
  maxBodyBytes,
} from '../../src/http/body-limit.js';

const reading = (value: string | undefined) => (key: string) =>
  key === MAX_BODY_KEY ? value : undefined;

describe('the JSON body limit', () => {
  it('is 16 MiB unless set, and an empty variable is unset', () => {
    expect(maxBodyBytes(reading(undefined))).toBe(DEFAULT_MAX_BODY);
    expect(maxBodyBytes(reading('  '))).toBe(DEFAULT_MAX_BODY);
  });

  it('reads bytes, including the float spelling Helm renders them in', () => {
    expect(maxBodyBytes(reading('1048576'))).toBe(1_048_576);
    expect(maxBodyBytes(reading('3.3554432e+07'))).toBe(33_554_432);
  });

  it.each([['10mb'], ['1.5'], ['1024'], [String(1024 ** 4)]])('refuses %s', (value) => {
    expect(() => maxBodyBytes(reading(value))).toThrow(BodyLimitMisconfigured);
  });
});
