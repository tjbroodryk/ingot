import { Changeset, type Payload, type Release } from '@ingot/versioning';
import { WireShape } from './shapes.js';

/**
 * The published versions of the Ingot API.
 *
 * The model is Stripe's, and the rule that comes with it is short: **only the
 * newest shape is ever implemented.** Handlers, DTOs and
 * `@ingot/shared/ingot-v1` describe the current contract and nothing else. An
 * older version is that contract with a stack of small, two-way transforms in
 * front of it — never a branch inside a handler.
 *
 * ## Adding a version
 *
 * 1. Change the wire contract, the DTOs and the handlers freely. Only the new
 *    shape exists in the codebase when you are done.
 * 2. Add a release below with today's date, and one `ShapeChange` per shape
 *    that moved. `forward` migrates an older *request* up; `backward` renders
 *    the current *response* down. Write both whenever a shape crosses in both
 *    directions, and check they round-trip.
 * 3. `LATEST` follows automatically — it is the last release.
 *
 * ## Two things a change must not do
 *
 * **Never walk into caller-owned data.** `QueryResult.rows` holds whatever the
 * caller stored in their own tables, and `AddBody.result` is an arbitrary tool
 * result. A transform that rewrote a key inside those would be corrupting
 * somebody's data in the name of an envelope rename — and it would do it
 * silently, to the callers least able to notice. `versioning.test.ts` runs
 * every shipped change over a fixture with junk in those fields and asserts it
 * comes back untouched, so this is a trap that arms itself rather than a note
 * anyone has to remember.
 *
 * **Never change behaviour, only shape.** A version is a rendering of one
 * implementation. If a release would make the service *do* something
 * different for old callers, that is not a version — it is a second product.
 */
const RELEASES: readonly Release[] = [
  {
    version: '2026-08-26',
    summary:
      'The first published shape: accounts and keys, ingots, the mapping DSL, ' +
      'SQL and semantic query, and tombstone deletes.',
    // The baseline transforms nothing — there is nothing older to transform
    // to. The engine refuses a baseline that claims otherwise.
    changes: [],
  },
  {
    version: '2026-08-27',
    summary:
      'Tables carry settings: `POST /:ingot/config/:table` sets how a table is ' +
      'indexed for full text search, and every `TableInfo` reports what it is ' +
      'set to.',
    changes: [
      {
        shape: WireShape.IngotInfo,
        note: 'Each table gained `config`, its full text search settings.',
        backward: (value) => ({
          ...value,
          tables: asArray(value.tables).map(withoutConfig),
        }),
      },
      {
        shape: WireShape.AddResult,
        note: 'The receipt’s `table` gained `config`, as `IngotInfo`’s tables did.',
        backward: (value) => {
          // Only when a receipt was asked for, and only the envelope: the
          // receipt's `items` are the caller's own row values and nothing here
          // goes near them.
          const receipt = asObject(value.receipt);
          if (!receipt) return value;
          const table = asObject(receipt.table);
          if (!table) return value;

          return { ...value, receipt: { ...receipt, table: withoutConfig(table) } };
        },
      },
    ],
  },
];

/**
 * A `TableInfo` as it was before it had settings.
 *
 * Deleting the key rather than nulling it: a caller on the older version was
 * written against a shape with no such field, and a null is still a field.
 */
function withoutConfig(table: Payload): Payload {
  const { config: _dropped, ...rest } = table;
  return rest;
}

function asArray(value: unknown): Payload[] {
  return Array.isArray(value) ? (value as Payload[]) : [];
}

function asObject(value: unknown): Payload | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

export const INGOT_VERSIONS = new Changeset(RELEASES);

/** The header a caller names a version in, and the one answered with. */
export const VERSION_HEADER = 'Ingot-Version';
