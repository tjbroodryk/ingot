import { Injectable } from '@nestjs/common';
import { type SQL, eq } from 'drizzle-orm';
import { ConflictingState } from '../../../../shared/domain/index.js';
import { writeAggregate } from '../../../../shared/infrastructure/postgres/aggregate-write.js';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import {
  Account,
  AccountId,
  AccountKeyId,
  type AccountKeyRecord,
  type AccountRepository,
  AccountSlug,
} from '../../domain/index.js';
import { type AccountKeyRow, type AccountRow, account, accountKey } from './schema.js';

function rehydrate(row: AccountRow, keyRows: readonly AccountKeyRow[]): Account {
  const keys: AccountKeyRecord[] = keyRows.map((key) => ({
    id: AccountKeyId.of(key.id),
    digest: key.digest,
    prefix: key.prefix,
    label: key.label,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }));
  return Account.rehydrate(
    AccountId.of(row.id),
    { slug: AccountSlug.of(row.slug), name: row.name, createdAt: row.createdAt, keys },
    row.version,
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Injectable()
export class PgAccountRepository implements AccountRepository {
  constructor(private readonly uow: PgUnitOfWork) {}

  async save(aggregate: Account): Promise<void> {
    const row = {
      id: aggregate.id.value,
      slug: aggregate.slug.value,
      name: aggregate.name,
      createdAt: aggregate.createdAt,
    };

    try {
      await writeAggregate(aggregate, ({ next, expected }) =>
        this.uow.queryable
          .insert(account)
          .values({ ...row, version: next })
          .onConflictDoUpdate({
            target: account.id,
            set: { ...row, version: next },
            setWhere: eq(account.version, expected),
          })
          .returning({ id: account.id }),
      );
    } catch (error) {
      // The handler checks the slug for the sake of the message; this catches
      // the race between two requests that both passed that check.
      if (isUniqueViolation(error)) {
        throw new ConflictingState(`The account slug "${aggregate.slug.value}" is taken`);
      }
      throw error;
    }

    // Keys are part of the aggregate, so they land in the transaction the
    // version guard just succeeded in. Upsert with no delete pass: a key is
    // never removed from an account, only revoked, so the set only grows.
    for (const key of aggregate.keys) {
      const keyRow = {
        id: key.id.value,
        accountId: aggregate.id.value,
        digest: key.digest,
        prefix: key.prefix,
        label: key.label,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      };
      await this.uow.queryable
        .insert(accountKey)
        .values(keyRow)
        .onConflictDoUpdate({ target: accountKey.id, set: keyRow });
    }
  }

  findById(id: AccountId): Promise<Account | null> {
    return this.load(eq(account.id, id.value));
  }

  findBySlug(slug: string): Promise<Account | null> {
    return this.load(eq(account.slug, slug));
  }

  async findByKeyDigest(digest: string): Promise<Account | null> {
    const [match] = await this.uow.queryable
      .select({ accountId: accountKey.accountId })
      .from(accountKey)
      .where(eq(accountKey.digest, digest))
      .limit(1);
    return match ? this.load(eq(account.id, match.accountId)) : null;
  }

  async touch(keyId: AccountKeyId, at: Date): Promise<void> {
    await this.uow.queryable
      .update(accountKey)
      .set({ lastUsedAt: at })
      .where(eq(accountKey.id, keyId.value));
  }

  private async load(where: SQL): Promise<Account | null> {
    const [row] = await this.uow.queryable.select().from(account).where(where).limit(1);
    if (!row) return null;
    const keys = await this.uow.queryable
      .select()
      .from(accountKey)
      .where(eq(accountKey.accountId, row.id));
    return rehydrate(row, keys);
  }
}
