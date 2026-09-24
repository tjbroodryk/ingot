import { Changeset, type Payload, type Release } from '@ingot/versioning';
import { WireShape } from './shapes.js';

/**
 * The published versions of the Ingot API.
 *
 * Only the newest shape is implemented; older versions are two-way transforms
 * in front of it — `forward` migrates a request up, `backward` renders a
 * response down. Transforms rewrite shape only, never caller-owned data.
 */
const RELEASES: readonly Release[] = [
  {
    version: '2026-08-26',
    summary:
      'The first published shape: accounts and keys, ingots, the mapping DSL, ' +
      'SQL and semantic query, and tombstone deletes.',
    // The baseline transforms nothing; the engine refuses one that claims otherwise.
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
          // Only the envelope; the receipt's `items` are caller data and untouched.
          const receipt = asObject(value.receipt);
          if (!receipt) return value;
          const table = asObject(receipt.table);
          if (!table) return value;

          return { ...value, receipt: { ...receipt, table: withoutConfig(table) } };
        },
      },
    ],
  },
  {
    version: '2026-09-06',
    summary:
      'Memories carry settings: `POST /:ingot/config` sets where a receipt is ' +
      'delivered — a webhook or a queue — and `IngotInfo` reports what it is ' +
      'set to. Receipts are still collected by their query; delivery is opt-in.',
    changes: [
      {
        shape: WireShape.IngotInfo,
        note: 'The memory gained `config`, its delivery settings.',
        // Removed rather than nulled — a null is still a field. See `withoutConfig`.
        backward: (value) => {
          const { config: _dropped, ...rest } = value;
          return rest;
        },
      },
    ],
  },
];

/** A `TableInfo` as it was before it had settings; the key is deleted, not nulled. */
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
