import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { AuthMode } from '../../src/auth/auth-mode.js';
import {
  AuthMisconfigured,
  type Setting,
  authSettings,
  fileBackedReader,
} from '../../src/auth/auth-settings.js';
import { ApiKey, KEY_PREFIX } from '../../src/contexts/accounts/domain/index.js';

/**
 * How a deployment says who may call it, and which configurations it is
 * refused.
 *
 * The same argument as `storage.test.ts` and `ai-settings.test.ts`, applied to
 * the one setting where a quiet fallback would be worst. A bucket that falls
 * back loses data; a model that falls back makes search lexical; an
 * authentication mode that fell back would let the wrong people read the
 * memories. So there is no fallback, and this is what refusal looks like.
 *
 * Pure throughout: settings are parsed from a reader, so the whole matrix is
 * covered without a boot, a database or a request. The one impure corner —
 * `<NAME>_FILE` — gets a real temporary file, because the thing worth
 * asserting about it is that it reads one.
 */

/** An environment, as `ConfigService.get` would present it. */
function env(values: Record<string, string>): Setting {
  return (key) => values[key];
}

/** A key of the right shape, generated so the suite holds no usable secret. */
const KEY = ApiKey.mint().secret;

const scratch = mkdtempSync(join(tmpdir(), 'ingot-auth-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the mode selector', () => {
  it('refuses to guess when INGOT_AUTH is unset', () => {
    expect(() => authSettings(env({}))).toThrow(AuthMisconfigured);
    // The message has to say what to do, because the person reading it is
    // holding a service that will not start.
    expect(() => authSettings(env({}))).toThrow(/INGOT_AUTH is not set/);
    expect(() => authSettings(env({}))).toThrow(/sealed/);
  });

  it('refuses a mode it does not have', () => {
    const read = env({ INGOT_AUTH: 'open', INGOT_ACCOUNT: 'acme', INGOT_API_KEY: KEY });
    expect(() => authSettings(read)).toThrow(/not a mode this service has/);
  });

  it('treats a blank variable as unset rather than as a mode called ""', () => {
    expect(() => authSettings(env({ INGOT_AUTH: '   ' }))).toThrow(/is not set/);
  });

  it('is case-insensitive about the mode it is given', () => {
    const read = env({ INGOT_AUTH: 'SEALED', INGOT_ACCOUNT: 'acme', INGOT_API_KEY: KEY });
    expect(authSettings(read).mode).toBe(AuthMode.Sealed);
  });
});

describe('sealed', () => {
  it('parses the account and the root key', () => {
    const settings = authSettings(
      env({
        INGOT_AUTH: 'sealed',
        INGOT_ACCOUNT: 'acme',
        INGOT_ACCOUNT_NAME: 'Acme Corp',
        INGOT_API_KEY: KEY,
      }),
    );

    expect(settings).toEqual({
      mode: AuthMode.Sealed,
      slug: 'acme',
      name: 'Acme Corp',
      keyDigest: ApiKey.digestOf(KEY),
      keyPrefix: KEY.slice(0, KEY_PREFIX.length + 6),
    });
  });

  /**
   * The property the whole file exists for: the secret goes in and does not
   * come out. Everything downstream of the parser holds a digest, so a settings
   * object that leaked into a log or an error would leak nothing usable.
   */
  it('keeps no usable copy of the secret', () => {
    const settings = authSettings(
      env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'acme', INGOT_API_KEY: KEY }),
    );

    expect(JSON.stringify(settings)).not.toContain(KEY);
    expect(Object.values(settings)).not.toContain(KEY);
  });

  it('names every missing variable at once', () => {
    const read = env({ INGOT_AUTH: 'sealed' });
    // One restart, not three: an operator filling in a template should learn
    // the whole of what is left.
    expect(() => authSettings(read)).toThrow(/INGOT_ACCOUNT, INGOT_API_KEY/);
    expect(() => authSettings(read)).toThrow(/Missing: INGOT_ACCOUNT, INGOT_API_KEY/);
  });

  it('refuses a key that is not shaped like one of ours', () => {
    const read = env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'acme', INGOT_API_KEY: 'hunter2' });
    expect(() => authSettings(read)).toThrow(/does not look like a key this service issues/);
    // And says how to make one, since the alternative is inventing a string.
    expect(() => authSettings(read)).toThrow(/openssl rand/);
  });

  it('refuses a key nobody would have had to generate', () => {
    const read = env({
      INGOT_AUTH: 'sealed',
      INGOT_ACCOUNT: 'acme',
      // Shaped like ours and long enough for `looksLikeOurs`, which is the
      // request-path question. As a root credential it is a placeholder.
      INGOT_API_KEY: `${KEY_PREFIX}changeme`,
    });
    expect(() => authSettings(read)).toThrow(/will not accept a root credential shorter/);
  });

  it('refuses an account slug that would shadow this service’s own routes', () => {
    const read = env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'accounts', INGOT_API_KEY: KEY });
    // `/accounts/…` is key management. An account called `accounts` would sit
    // in front of it, and finding that out at the seed would be a confusing
    // insert error rather than a variable to fix.
    expect(() => authSettings(read)).toThrow(/INGOT_ACCOUNT is "accounts"/);
    expect(() => authSettings(read)).toThrow(/reserved/);
  });

  it('refuses a slug that is not a slug', () => {
    const read = env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'Acme Corp!', INGOT_API_KEY: KEY });
    expect(() => authSettings(read)).toThrow(AuthMisconfigured);
  });

  it('lowercases the slug it was given, as AccountSlug does', () => {
    const read = env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'ACME', INGOT_API_KEY: KEY });
    expect(authSettings(read).slug).toBe('acme');
  });
});

describe('reading a secret from a file', () => {
  it('takes <NAME>_FILE when the variable itself is unset', () => {
    const path = join(scratch, 'key');
    // With the trailing newline every editor and every `echo` leaves behind,
    // because a key that only works without one is a key that never works.
    writeFileSync(path, `${KEY}\n`);

    const settings = authSettings(
      fileBackedReader(
        env({ INGOT_AUTH: 'sealed', INGOT_ACCOUNT: 'acme', INGOT_API_KEY_FILE: path }),
      ),
    );

    expect(settings.keyDigest).toBe(ApiKey.digestOf(KEY));
  });

  it('prefers the variable when both are set', () => {
    const path = join(scratch, 'other');
    writeFileSync(path, ApiKey.mint().secret);

    const settings = authSettings(
      fileBackedReader(
        env({
          INGOT_AUTH: 'sealed',
          INGOT_ACCOUNT: 'acme',
          INGOT_API_KEY: KEY,
          INGOT_API_KEY_FILE: path,
        }),
      ),
    );

    expect(settings.keyDigest).toBe(ApiKey.digestOf(KEY));
  });

  it('refuses a file it cannot read rather than falling back to unset', () => {
    const read = fileBackedReader(
      env({
        INGOT_AUTH: 'sealed',
        INGOT_ACCOUNT: 'acme',
        INGOT_API_KEY_FILE: join(scratch, 'not-here'),
      }),
    );
    // A missing mount that read as "no key configured" would produce the
    // "INGOT_API_KEY is required" message, which sends the operator to fix
    // the wrong thing.
    expect(() => authSettings(read)).toThrow(/INGOT_API_KEY_FILE points at/);
  });

  it('works for every key, not only the ones auth happens to use', () => {
    const path = join(scratch, 'slug');
    writeFileSync(path, 'from-a-file');

    const read = fileBackedReader(env({ INGOT_ACCOUNT_FILE: path }));
    expect(read('INGOT_ACCOUNT')).toBe('from-a-file');
  });
});
