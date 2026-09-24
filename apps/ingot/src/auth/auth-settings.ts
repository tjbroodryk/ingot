import { readFileSync } from 'node:fs';
import { Guard } from '../shared/domain/index.js';
import { AccountSlug, ApiKey, KEY_PREFIX } from '../contexts/accounts/domain/index.js';
import { AuthMode } from './auth-mode.js';

/** How authentication is configured, parsed once at boot. */
export type AuthSettings = SealedAuth;

export interface SealedAuth {
  readonly mode: AuthMode.Sealed;
  /** The one account, validated as an `AccountSlug` at boot. */
  readonly slug: string;
  readonly name?: string;
  /** The root key, as a digest; the secret is discarded. */
  readonly keyDigest: string;
  /** Enough of the key to recognise it in a log line, never enough to use. */
  readonly keyPrefix: string;
}

/** Shortest root key accepted: prefix plus the 24 random bytes a minted key carries. */
const MIN_SECRET_LENGTH = KEY_PREFIX.length + 24;

/** Reads one environment variable. */
export type Setting = (key: string) => string | undefined;

/** Thrown at boot when authentication cannot be configured. */
export class AuthMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthMisconfigured';
  }
}

export function authSettings(read: Setting): AuthSettings {
  return MODE_PARSERS[mode(read)](read);
}

/** Keyed on the enum, so a mode added without a reader fails to compile. */
const MODE_PARSERS: Record<AuthMode, (read: Setting) => AuthSettings> = {
  [AuthMode.Sealed]: (read) => {
    const [slug, secret] = demand(read, AuthMode.Sealed, ['INGOT_ACCOUNT', 'INGOT_API_KEY']);
    const key = rootKey(secret);

    return {
      mode: AuthMode.Sealed,
      // Validated at boot rather than at the seed, so a bad slug fails here.
      slug: accountSlug(slug),
      name: value(read('INGOT_ACCOUNT_NAME')),
      keyDigest: key.digest,
      keyPrefix: key.prefix,
    };
  },
};

/** A reader that also answers from a `<KEY>_FILE` pointing at a mounted file. */
export function fileBackedReader(read: Setting): Setting {
  return (key) => value(read(key)) ?? fileAt(value(read(`${key}_FILE`)), key);
}

function fileAt(path: string | undefined, key: string): string | undefined {
  if (path === undefined) return undefined;

  try {
    return value(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AuthMisconfigured(
      `${key}_FILE points at ${path}, which could not be read: ${String(error)}`,
    );
  }
}

/** The named `INGOT_AUTH` mode. There is no default. */
function mode(read: Setting): AuthMode {
  const named = value(read('INGOT_AUTH'));
  if (named === undefined) {
    throw new AuthMisconfigured(
      'INGOT_AUTH is not set, and there is no default: a service that guessed how to ' +
        'authenticate would be guessing who may read the memories in it. ' +
        `Choose one of: ${Object.values(AuthMode).join(', ')}.`,
    );
  }

  try {
    return Guard.oneOf(named.toLowerCase(), Object.values(AuthMode), 'INGOT_AUTH');
  } catch {
    throw new AuthMisconfigured(
      `INGOT_AUTH is "${named}", which is not a mode this service has. ` +
        `Choose one of: ${Object.values(AuthMode).join(', ')}.`,
    );
  }
}

function rootKey(secret: string): ApiKey {
  if (!ApiKey.looksLikeOurs(secret)) {
    throw new AuthMisconfigured(
      `INGOT_API_KEY does not look like a key this service issues — it must start with ` +
        `"${KEY_PREFIX}". Generate one with: ` +
        `echo "${KEY_PREFIX}$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"`,
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthMisconfigured(
      `INGOT_API_KEY is ${secret.length} characters, and this service will not accept a root ` +
        `credential shorter than ${MIN_SECRET_LENGTH}. It is the one key that cannot be revoked ` +
        'from inside the service, so it is the one worth generating rather than choosing.',
    );
  }
  return ApiKey.from(secret);
}

function accountSlug(raw: string): string {
  try {
    return AccountSlug.of(raw).value;
  } catch (error) {
    throw new AuthMisconfigured(
      `INGOT_ACCOUNT is "${raw}", which is not a usable account slug: ${String(error)}`,
    );
  }
}

/** Every value a mode needs, or throws naming all the missing ones at once. */
function demand<const K extends readonly string[]>(
  read: Setting,
  named: AuthMode,
  keys: K,
): { [I in keyof K]: string } {
  const found = keys.map((key) => value(read(key)));
  const missing = keys.filter((_key, at) => found[at] === undefined);

  if (missing.length > 0) {
    throw new AuthMisconfigured(
      `INGOT_AUTH=${named} needs ${keys.join(', ')}. Missing: ${missing.join(', ')}. ` +
        'Each may also be given as <NAME>_FILE pointing at a mounted file.',
    );
  }
  // Every element was proved present above; the type of `map` can't carry that.
  return found as { [I in keyof K]: string };
}

/** Blank is treated as unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
