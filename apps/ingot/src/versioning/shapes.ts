/**
 * Every wire shape this service versions, as a closed set.
 *
 * An enum rather than bare strings for the reason `CLAUDE.md` gives: a change
 * naming `'IngotInfo'` as a quoted string is a string that happens to
 * typecheck, and renaming a shape becomes a hunt through quoted copies. Here
 * it is a rename the compiler performs.
 *
 * `versioning.test.ts` asserts every member is a type `@ingot/shared/ingot-v1`
 * actually exports, so this cannot drift from the contract it names.
 */
export enum WireShape {
  Account = 'Account',
  AccountDetail = 'AccountDetail',
  AccountKey = 'AccountKey',
  MintedKey = 'MintedKey',
  CreatedAccount = 'CreatedAccount',
  CreateAccountBody = 'CreateAccountBody',
  MintKeyBody = 'MintKeyBody',

  IngotSummary = 'IngotSummary',
  IngotInfo = 'IngotInfo',
  CreateIngotBody = 'CreateIngotBody',

  TableConfig = 'TableConfig',
  ConfigureTableBody = 'ConfigureTableBody',

  AddBody = 'AddBody',
  AddResult = 'AddResult',

  QueryBody = 'QueryBody',
  QueryResult = 'QueryResult',

  DeleteBody = 'DeleteBody',
  DeleteResult = 'DeleteResult',
}
