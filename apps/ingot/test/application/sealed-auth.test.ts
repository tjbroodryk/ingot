import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TestingModule } from '@nestjs/testing';
import { AuthenticationFailed, CLOCK, type Clock } from '../../src/shared/domain/index.js';
import { AUTHENTICATOR, type Authenticator } from '../../src/auth/authenticator.port.js';
import { SealedAuthenticator } from '../../src/auth/sealed-authenticator.js';
import { AccountAuthenticator } from '../../src/contexts/accounts/application/account-authenticator.js';
import { MintKey } from '../../src/contexts/accounts/application/commands/mint-key.command.js';
import {
  ACCOUNT_REPOSITORY,
  ApiKey,
  type AccountRepository,
} from '../../src/contexts/accounts/domain/index.js';
import { Dispatcher } from '../../src/shared/application/index.js';
import { TEST_AUTH, TEST_ROOT_KEY, compileAppModule } from '../support/app.js';
import { closeDatabase, openDatabase } from '../support/database.js';

/**
 * Sealed mode, against the real module graph and a real database.
 *
 * The properties worth holding here are the ones that cannot be seen from
 * `auth-settings.test.ts`, which only proves the configuration was read: that
 * the account is opened without anybody asking, that the root key works with
 * nothing in `account_key` to back it, that a key minted afterwards works
 * *too*, and that the root key survives everything the service can be told to
 * do to its credentials.
 *
 * No truncate between assertions. The seed happens once at bootstrap, and a
 * table emptied underneath a running authenticator would be testing a
 * situation the service is not in.
 */
describe('sealed mode', () => {
  let app: TestingModule;
  let authenticator: Authenticator;
  let accounts: AccountRepository;
  let dispatcher: Dispatcher;

  beforeAll(async () => {
    const { truncate } = await openDatabase();
    // Before the seed, not between the assertions: this is the empty database
    // the deployment's first boot meets.
    await truncate();

    app = await compileAppModule().compile();
    await app.init();

    authenticator = app.get<Authenticator>(AUTHENTICATOR);
    accounts = app.get<AccountRepository>(ACCOUNT_REPOSITORY);
    dispatcher = app.get(Dispatcher);
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  describe('the account', () => {
    it('opens itself at boot, with no route having been called', async () => {
      const account = await accounts.findBySlug(TEST_AUTH.slug);
      expect(account).not.toBeNull();
      expect(account?.slug.value).toBe(TEST_AUTH.slug);
    });

    /**
     * The property that makes the chart's two replicas safe. `save` is
     * attempted again against a slug that now exists, and the unique index
     * turns the loser of that race into a no-op rather than a crashloop.
     */
    it('is idempotent, because every replica runs the same seed', async () => {
      const again = new SealedAuthenticator(
        TEST_AUTH,
        accounts,
        app.get(AccountAuthenticator),
        app.get<Clock>(CLOCK),
      );
      await again.onApplicationBootstrap();
      await again.onApplicationBootstrap();

      const account = await accounts.findBySlug(TEST_AUTH.slug);
      expect(account).not.toBeNull();
    });
  });

  describe('the root key', () => {
    it('authenticates, and says it came in as the root', async () => {
      const principal = await authenticator.authenticate(TEST_ROOT_KEY.secret);

      expect(principal.via).toBe('root');
      expect(principal.account.slug.value).toBe(TEST_AUTH.slug);
    });

    /**
     * The whole argument for checking a digest held in the process rather than
     * a row: there is nothing in the table to revoke, to leave behind on a
     * rotation, or to go stale.
     */
    it('has no row in account_key backing it', async () => {
      const account = await accounts.findBySlug(TEST_AUTH.slug);
      expect(account?.keys).toEqual([]);

      // And the ordinary digest lookup — the one every minted key goes
      // through — cannot find it either.
      const lookup = accounts.findByKeyDigest(ApiKey.digestOf(TEST_ROOT_KEY.secret));
      expect(await lookup).toBeNull();
    });

    it('refuses another key of exactly the same shape', async () => {
      const impostor = ApiKey.mint().secret;
      expect(authenticator.authenticate(impostor)).rejects.toThrow(AuthenticationFailed);
    });

    it('refuses something that is not shaped like a key at all', async () => {
      expect(authenticator.authenticate('hunter2')).rejects.toThrow(AuthenticationFailed);
    });

    it('says the same thing for every kind of failure', async () => {
      // A caller holding an invalid key has not earned the difference between
      // "wrong key", "revoked key" and "no such account".
      const messages = await Promise.all(
        [ApiKey.mint().secret, 'hunter2', `${TEST_ROOT_KEY.secret}x`].map((presented) =>
          authenticator.authenticate(presented).catch((error: Error) => error.message),
        ),
      );
      expect(new Set(messages).size).toBe(1);
    });
  });

  describe('keys minted under it', () => {
    it('authenticate too, and are told apart from the root', async () => {
      const account = await accounts.findBySlug(TEST_AUTH.slug);
      const minted = await dispatcher.send(new MintKey(account?.id.value ?? '', 'an agent'));

      const principal = await authenticator.authenticate(minted.secret);

      expect(principal.via).toBe('key');
      expect(principal.account.slug.value).toBe(TEST_AUTH.slug);
      // Which is the difference that makes one revocable and the other not.
      expect(principal.via === 'key' && principal.keyId.value).toBe(minted.id);
    });

    /**
     * The reason sealed mode keeps the digest lookup rather than being the
     * only key: one shared secret across every agent means revoking one means
     * rotating all of them, and rotating the root key is a restart.
     */
    it('leave the root key working after they are revoked', async () => {
      const account = await accounts.findBySlug(TEST_AUTH.slug);
      const id = account?.id.value ?? '';

      const doomed = await dispatcher.send(new MintKey(id, 'to be revoked'));
      // A second key, because `Account.revoke` refuses to take the last live
      // one — an invariant written for a service with no root credential, and
      // the one thing sealed mode makes stricter than it needs to be.
      await dispatcher.send(new MintKey(id, 'a spare'));

      const { RevokeKey } = await import(
        '../../src/contexts/accounts/application/commands/revoke-key.command.js'
      );
      await dispatcher.send(new RevokeKey(id, doomed.id));

      expect(authenticator.authenticate(doomed.secret)).rejects.toThrow(AuthenticationFailed);
      expect((await authenticator.authenticate(TEST_ROOT_KEY.secret)).via).toBe('root');
    });
  });

  it('says what it is, for the boot log', () => {
    const description = authenticator.describe();

    expect(description).toContain(TEST_AUTH.slug);
    expect(description).toContain(TEST_AUTH.keyPrefix);
    // And never the secret itself, which is the point of holding a prefix.
    expect(description).not.toContain(TEST_ROOT_KEY.secret);
  });
});
