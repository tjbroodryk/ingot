/** Every wire shape this service versions, as a closed set. */
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

  IngotConfig = 'IngotConfig',
  ConfigureIngotBody = 'ConfigureIngotBody',
  /** Not returned by any route: the body this service sends to a webhook. */
  DeliveredReceipt = 'DeliveredReceipt',

  AddBody = 'AddBody',
  AddResult = 'AddResult',

  QueryBody = 'QueryBody',
  QueryResult = 'QueryResult',

  DeleteBody = 'DeleteBody',
  DeleteResult = 'DeleteResult',

  /** `/file` takes multipart, so only the response is a versioned shape. */
  FileResult = 'FileResult',
}
