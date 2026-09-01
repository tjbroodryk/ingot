import type {
  Account as AccountWire,
  AccountKey,
  CreatedAccount,
  MintedKey,
} from '@ingot/shared/ingot-v1';
import type { Account, AccountKeyRecord, ApiKey } from '../domain/index.js';

export function toAccountWire(account: Account): AccountWire {
  return {
    id: account.id.value,
    slug: account.slug.value,
    name: account.name,
    createdAt: account.createdAt.toISOString(),
  };
}

export function toKeyWire(key: AccountKeyRecord): AccountKey {
  return {
    id: key.id.value,
    label: key.label,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/** The one shape carrying a usable secret. Nothing else may produce it. */
export function toMintedKey(key: AccountKeyRecord, secret: string): MintedKey {
  return { ...toKeyWire(key), secret };
}

export function toCreatedAccount(account: Account, key: ApiKey): CreatedAccount {
  const record = account.keys.find((candidate) => candidate.digest === key.digest);
  if (!record) throw new Error('The minted key is not on the account it was minted for');
  return { account: toAccountWire(account), key: toMintedKey(record, key.secret) };
}
