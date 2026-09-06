import { readFileSync } from 'node:fs';
import { Guard } from '../shared/domain/index.js';
import { AccountSlug, ApiKey, KEY_PREFIX } from '../contexts/accounts/domain/index.js';
import { AuthMode } from './auth-mode.js';

/**
 * How this deployment authenticates, read once at boot.
 *
 * The same shape as `storage-settings.ts` and `ai-settings.ts`, for the same
 * reasons: parsed into a discriminated union rather than passed round as a bag
 * of optional strings, so an adapter's constructor cannot be reached without
 * the values it needs; and a pure function over a reader, which is what lets
 * the whole matrix be asserted in a unit test rather than by booting the
 * service once per mode and reading a log line.
 *
 * One thing is different, and it is the reason this file exists rather than
 * the settings being parsed inside the module: a credential is involved. The
 * secret is turned into a digest here and discarded. Nothing downstream of
 * this function has ever seen it, which is the same bargain `ApiKey` makes
 * with Postgres and is worth making with the process too.
 */
export type AuthSettings = SealedAuth;

export interface SealedAuth {
  readonly mode: AuthMode.Sealed;
  /** The one account. Validated as an `AccountSlug` at boot, not at first use. */
  readonly slug: string;
  readonly name?: string;
  /** The root key, as a digest. The secret does not leave `authSettings`. */
  readonly keyDigest: string;
  /** Enough of the key to recognise it in a log line. Never enough to use. */
  readonly keyPrefix: string;
}

/**
 * The shortest root key this service will accept.
 *
 * `ApiKey.looksLikeOurs` only asks that a key be shaped like one of ours,
 * which is the right question on the request path and the wrong one here: it
 * would accept `ing_sk_test` from a deployment template nobody finished
 * filling in. A minted key carries 24 random bytes; this asks for a comparable
 * amount of typing and refuses anything an operator could have thought up.
 */
const MIN_SECRET_LENGTH = KEY_PREFIX.length + 24;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/**
 * A deployment that cannot authenticate anybody.
 *
 * Fatal, for the reason `StorageMisconfigured` and `AiMisconfigured` are — and
 * more so than either. A service that boots without knowing how to tell
 * callers apart either refuses every request, or, if it were allowed a
 * fallback, accepts the wrong ones. Refusing to start says it once, to the
 * person holding the deployment, before anything is listening.
 */
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
      // Checked here rather than at the seed, so `INGOT_ACCOUNT=accounts` — a
      // slug that would shadow this service's own routes — is a boot failure
      // naming the variable rather than a confusing insert error later.
      slug: accountSlug(slug),
      name: value(read('INGOT_ACCOUNT_NAME')),
      keyDigest: key.digest,
      keyPrefix: key.prefix,
    };
  },
};

/**
 * A reader that also answers from a file.
 *
 * `INGOT_API_KEY_FILE=/run/secrets/ingot-key` is the Docker and Kubernetes
 * convention for a secret that should not be an environment variable —
 * `/proc/<pid>/environ`, a crash dump and anything that logs the environment
 * all read those, and a mounted file is none of those things.
 *
 * Written as a decorator over a reader rather than as a branch inside each
 * parser, so it holds for every key uniformly and the parsers stay pure
 * functions over strings. The impure edge is here, and it is four lines.
 */
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

/**
 * The mode this deployment named. There is no default.
 *
 * `INGOT_STORAGE` refuses to guess where Parquet goes; this refuses to guess
 * who may read it. The two selectors that do have defaults — the embedder and
 * the summariser — default to something offline and harmless that announces
 * itself as a stand-in. There is no harmless stand-in for authentication.
 */
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

/**
 * Every value a mode cannot work without, or a message naming the ones that
 * are missing.
 *
 * All of them at once rather than the first, so an operator filling in a
 * deployment template learns what is left in one restart rather than in three.
 */
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
  // Every element was just proved present, which is a fact about the loop
  // above rather than one the type of `map` can carry.
  return found as { [I in keyof K]: string };
}

/** Blank is unset. A variable exported as `""` is one somebody meant to omit. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
