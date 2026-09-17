import { type Delivered, DeliveryEvent } from './contract.js';
import { UnknownDeliveryEventError, ValidationError } from './errors.js';

type Check = 'string' | 'number' | 'nullable-string';

const FIELDS: Record<DeliveryEvent, Readonly<Record<string, Check>>> = {
  [DeliveryEvent.ReceiptReady]: {
    ingot: 'string',
    batch: 'string',
    externalId: 'nullable-string',
    sourceTable: 'string',
    summary: 'string',
    searchTerm: 'string',
    totalResults: 'number',
    query: 'string',
    model: 'string',
    readyAt: 'string',
    attempt: 'number',
  },
  [DeliveryEvent.OperationsAppended]: {
    ingot: 'string',
    table: 'string',
    generation: 'number',
    throughSeq: 'nullable-string',
    rows: 'number',
    tombstones: 'number',
    at: 'string',
    attempt: 'number',
  },
  [DeliveryEvent.TableRolledUp]: {
    ingot: 'string',
    table: 'string',
    generation: 'number',
    previousGeneration: 'number',
    rows: 'number',
    at: 'string',
    attempt: 'number',
  },
  [DeliveryEvent.TableDropped]: {
    ingot: 'string',
    table: 'string',
    at: 'string',
    attempt: 'number',
  },
};

/**
 * A webhook body or queue message, checked and typed.
 *
 * Accepts the raw text or the parsed JSON. An `event` this SDK does not know
 * throws `UnknownDeliveryEventError` rather than `ValidationError`, because
 * the server adds events over time and a receiver should acknowledge and
 * ignore those rather than answer with a failure that gets retried.
 */
export function parseDelivery(body: unknown): Delivered {
  const parsed = typeof body === 'string' ? parseJson(body) : body;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('the body is not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.event !== 'string') throw invalid('it has no "event"');

  if (!Object.hasOwn(FIELDS, record.event)) {
    throw new UnknownDeliveryEventError(record.event);
  }
  const fields = FIELDS[record.event as DeliveryEvent];

  for (const [field, check] of Object.entries(fields)) {
    const value = record[field];
    const ok =
      check === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : check === 'string'
          ? typeof value === 'string'
          : value === null || typeof value === 'string';
    if (!ok) throw invalid(`"${field}" is missing or not a ${check.replace('-', ' ')}`);
  }

  return record as unknown as Delivered;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('the body is not JSON');
  }
}

function invalid(reason: string): ValidationError {
  return new ValidationError(`Not an Ingot delivery: ${reason}`, { code: 'invalid_delivery' });
}
