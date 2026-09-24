import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValueObject } from '../../../shared/domain/index.js';

/** Prefix on every key this service issues. */
export const KEY_PREFIX = 'ing_sk_';

/** How much of a key is safe to store and show. */
const VISIBLE = KEY_PREFIX.length + 6;

/** A minted key. The secret exists only here; storage holds only the digest. */
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
    // 24 bytes of base64url: ~192 bits.
    return new ApiKey(`${KEY_PREFIX}${randomBytes(24).toString('base64url')}`);
  }

  /** Wraps an externally-supplied secret. No validation beyond the constructor's shape. */
  static from(secret: string): ApiKey {
    return new ApiKey(secret);
  }

  static digestOf(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /** Whether a presented key matches a stored digest, in constant time. */
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
