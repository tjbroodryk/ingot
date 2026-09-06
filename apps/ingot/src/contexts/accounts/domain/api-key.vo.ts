import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValueObject } from '../../../shared/domain/index.js';

/** Every key this service issues starts here, so one can be spotted in a log. */
export const KEY_PREFIX = 'ing_sk_';

/** How much of a key is safe to store and show: enough to tell two apart. */
const VISIBLE = KEY_PREFIX.length + 6;

/**
 * A minted key, which exists in this form exactly once.
 *
 * The secret is returned to the caller in the response that created it and is
 * never stored — Postgres holds `digest` and nothing else. That is the same
 * bargain `project_invitation` makes in `@forge/api`, and for the same reason:
 * a table of live credentials is a table worth stealing, and a digest is not.
 */
export class ApiKey extends ValueObject {
  readonly secret: string;
  readonly digest: string;
  readonly prefix: string;

  private constructor(secret: string) {
    super();
    this.secret = secret;
    this.digest = ApiKey.digestOf(secret);
    this.prefix = secret.slice(0, VISIBLE);
    this.seal();
  }

  static mint(): ApiKey {
    // 24 bytes of base64url, which is 32 characters of ~192 bits. Long enough
    // that guessing is not a strategy, short enough to paste into a header.
    return new ApiKey(`${KEY_PREFIX}${randomBytes(24).toString('base64url')}`);
  }

  /**
   * A key this service did not mint — the one configured for sealed mode.
   *
   * Separate from `mint` rather than an optional argument to it, because they
   * are different acts: `mint` produces a secret nobody has seen, and this
   * accepts one an operator generated and is holding in a Secret. Neither the
   * digest nor the prefix can be derived outside this file — `VISIBLE` is
   * private — so a caller that has a secret and wants those has to come here.
   *
   * No validation beyond the shape the constructor implies. Whether a key is
   * long enough to be a root credential is a deployment question, and
   * `auth-settings.ts` answers it where the message can name the variable.
   */
  static from(secret: string): ApiKey {
    return new ApiKey(secret);
  }

  static digestOf(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /**
   * Whether a presented key matches a stored digest.
   *
   * Constant time, because the comparison is against a secret and the naive
   * one leaks how many leading characters were right. Both sides are already
   * fixed-length hex digests, so the lengths always agree and the guard below
   * is for the malformed-input case rather than the attack.
   */
  static matches(presented: string, storedDigest: string): boolean {
    const candidate = Buffer.from(ApiKey.digestOf(presented), 'hex');
    const stored = Buffer.from(storedDigest, 'hex');
    if (candidate.length !== stored.length) return false;
    return timingSafeEqual(candidate, stored);
  }

  /** True for anything shaped like one of our keys. Not authentication. */
  static looksLikeOurs(value: string): boolean {
    return value.startsWith(KEY_PREFIX) && value.length > VISIBLE;
  }
}
