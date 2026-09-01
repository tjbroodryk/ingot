import { Identifier, newIdValue } from '../../../shared/domain/index.js';

export class AccountId extends Identifier {
  readonly prefix = 'acct';

  static of(value: string): AccountId {
    const id = new AccountId(value);
    id.validate();
    return id;
  }

  static generate(): AccountId {
    return AccountId.of(newIdValue('acct'));
  }
}

export class AccountKeyId extends Identifier {
  readonly prefix = 'key';

  static of(value: string): AccountKeyId {
    const id = new AccountKeyId(value);
    id.validate();
    return id;
  }

  static generate(): AccountKeyId {
    return AccountKeyId.of(newIdValue('key'));
  }
}
