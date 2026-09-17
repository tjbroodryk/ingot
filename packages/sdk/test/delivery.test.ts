import { describe, expect, it } from 'bun:test';
import {
  DeliveryEvent,
  UnknownDeliveryEventError,
  ValidationError,
  parseDelivery,
} from '../src/index.js';

const operations = {
  event: 'operations.appended',
  ingot: 'ing_1',
  table: 'tickets',
  generation: 4,
  throughSeq: null,
  rows: 0,
  tombstones: 2,
  at: '2026-09-17T10:00:00.000Z',
  attempt: 1,
};

describe('parseDelivery', () => {
  it('types a known event, from text or parsed JSON', () => {
    const parsed = parseDelivery(JSON.stringify(operations));
    expect(parsed.event).toBe(DeliveryEvent.OperationsAppended);
    if (parsed.event === DeliveryEvent.OperationsAppended) expect(parsed.tombstones).toBe(2);
    expect(parseDelivery(operations)).toEqual(parsed);
  });

  it('refuses a body missing a field the event requires', () => {
    const { rows: _dropped, ...partial } = operations;
    expect(() => parseDelivery(partial)).toThrow(ValidationError);
    expect(() => parseDelivery('not json')).toThrow(ValidationError);
    expect(() => parseDelivery([operations])).toThrow(ValidationError);
  });

  it('tells an event it does not know apart from a bad body', () => {
    const error = (() => {
      try {
        parseDelivery({ event: 'table.renamed' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UnknownDeliveryEventError);
    expect((error as UnknownDeliveryEventError).event).toBe('table.renamed');
    expect(() => parseDelivery({ event: 'constructor' })).toThrow(UnknownDeliveryEventError);
  });
});
