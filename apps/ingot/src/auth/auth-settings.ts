import { z } from 'zod';
import { type Ctx, choice, demand, section, text, type VarsOf } from '../config/vars.js';
import { AccountSlug, ApiKey, KEY_PREFIX } from '../contexts/accounts/domain/index.js';
import { AuthMode } from './auth-mode.js';

/**
 * How this deployment authenticates, read once at boot.
 *
 * The same shape as `storage-settings.ts` and `ai-settings.ts`, for the same
 * reasons: parsed into a discriminated union rather than passed round as a bag
 * of optional strings, so an adapter's constructor cannot be reached without
 * the values it needs; and a pure schema over the environment, which is what
 * lets the whole matrix be asserted in a unit test rather than by booting the
 * service once per mode and reading a log line.
 *
 * One thing is different: a credential is involved. The secret is turned into
 * a digest here and discarded. Nothing downstream of this section has ever
 * seen it, which is the same bargain `ApiKey` makes with Postgres and is worth
 * making with the process too. For the same reason no message here repeats
 * the value it is refusing.
 *
 * There is no fallback. A service that boots without knowing how to tell
 * callers apart either refuses every request, or, if it were allowed a
 * fallback, accepts the wrong ones.
 */
export type AuthSettings = SealedAuth;

export interface SealedAuth {
  readonly mode: AuthMode.Sealed;
  /** The one account. Validated as an `AccountSlug` at boot, not at first use. */
  readonly slug: string;
  readonly name?: string;
  /** The root key, as a digest. The secret does not leave this file. */
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

const MODES = `Choose one of: ${Object.values(AuthMode).join(', ')}.`;

const VARS = {
  INGOT_AUTH: choice(Object.values(AuthMode), `, which is not a mode this service has. ${MODES}`),
  INGOT_ACCOUNT: text(),
  INGOT_ACCOUNT_NAME: text(),
  // May be given as INGOT_API_KEY_FILE instead; `loadEnv` reads it.
  INGOT_API_KEY: text(),
};

type AuthVars = VarsOf<typeof VARS>;

/**
 * The mode this deployment named. There is no default.
 *
 * `INGOT_STORAGE` refuses to guess where Parquet goes; this refuses to guess
 * who may read it. The two selectors that do have defaults — the embedder and
 * the summariser — default to something offline and harmless that announces
 * itself as a stand-in. There is no harmless stand-in for authentication.
 */
export const authEnv = section(VARS, (vars, ctx): AuthSettings => {
  if (vars.INGOT_AUTH === undefined) {
    ctx.addIssue(
      'INGOT_AUTH is not set, and there is no default: a service that guessed how to ' +
        `authenticate would be guessing who may read the ingots in it. ${MODES}`,
    );
    return z.NEVER;
  }
  return MODE_BUILDERS[vars.INGOT_AUTH](vars, ctx) ?? z.NEVER;
});

/** Keyed on the enum, so a mode added without a builder fails to compile. */
const MODE_BUILDERS: Record<AuthMode, (vars: AuthVars, ctx: Ctx) => AuthSettings | undefined> = {
  [AuthMode.Sealed]: (vars, ctx) => {
    const found = demand(
      ctx,
      vars,
      `INGOT_AUTH=${AuthMode.Sealed}`,
      ['INGOT_ACCOUNT', 'INGOT_API_KEY'],
      ' Each may also be given as <NAME>_FILE pointing at a mounted file.',
    );
    if (found === undefined) return undefined;

    const [slug, secret] = found;
    // Both checked, so a deployment with two mistakes hears about both.
    const key = rootKey(secret, ctx);
    const account = accountSlug(slug, ctx);
    if (key === undefined || account === undefined) return undefined;

    return {
      mode: AuthMode.Sealed,
      // Checked here rather than at the seed, so `INGOT_ACCOUNT=accounts` — a
      // slug that would shadow this service's own routes — is a boot failure
      // naming the variable rather than a confusing insert error later.
      slug: account,
      name: vars.INGOT_ACCOUNT_NAME,
      keyDigest: key.digest,
      keyPrefix: key.prefix,
    };
  },
};

function rootKey(secret: string, ctx: Ctx): ApiKey | undefined {
  if (!ApiKey.looksLikeOurs(secret)) {
    ctx.addIssue(
      `INGOT_API_KEY does not look like a key this service issues — it must start with ` +
        `"${KEY_PREFIX}". Generate one with: ` +
        `echo "${KEY_PREFIX}$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"`,
    );
    return undefined;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    ctx.addIssue(
      `INGOT_API_KEY is ${secret.length} characters, and this service will not accept a root ` +
        `credential shorter than ${MIN_SECRET_LENGTH}. It is the one key that cannot be revoked ` +
        'from inside the service, so it is the one worth generating rather than choosing.',
    );
    return undefined;
  }
  return ApiKey.from(secret);
}

function accountSlug(raw: string, ctx: Ctx): string | undefined {
  try {
    return AccountSlug.of(raw).value;
  } catch (error) {
    ctx.addIssue(`INGOT_ACCOUNT is "${raw}", which is not a usable account slug: ${String(error)}`);
    return undefined;
  }
}
