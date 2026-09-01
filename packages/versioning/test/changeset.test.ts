import { describe, expect, it } from 'bun:test';
import { Changeset, MalformedChangeset, UnknownVersion, type Release } from '../src/index.js';

/**
 * The engine, against changes written for the test.
 *
 * Both services ship a changeset with a single baseline release and nothing to
 * transform, which is the right thing for a service with no external callers
 * yet — and it means the shipped transforms are all identity. So the machinery
 * is proved here instead, with fixture releases that do real work in both
 * directions. Otherwise the first time anyone found out whether the chain
 * composes correctly would be the first time it mattered.
 */

/** v1 → v2 renames `rows` to `each`; v2 → v3 nests a count. */
const RELEASES: readonly Release[] = [
  { version: '2026-01-01', summary: 'The first published shape.', changes: [] },
  {
    version: '2026-02-01',
    summary: 'Clearer name for the fan-out selector.',
    changes: [
      {
        shape: 'AddBody',
        note: '`rows` became `each`.',
        forward: (value) => {
          const { rows, ...rest } = value;
          return rows === undefined ? value : { ...rest, each: rows };
        },
        backward: (value) => {
          const { each, ...rest } = value;
          return each === undefined ? value : { ...rest, rows: each };
        },
      },
    ],
  },
  {
    version: '2026-03-01',
    summary: 'Counts nested so they cannot be mistaken for summing.',
    changes: [
      {
        shape: 'TableInfo',
        note: '`rows` and `pending` moved under `rows`.',
        forward: (value) => ({
          ...omit(value, 'rows', 'pending'),
          rows: { total: value.rows, pending: value.pending },
        }),
        backward: (value) => {
          const nested = value.rows as { total: number; pending: number };
          return { ...omit(value, 'rows'), rows: nested.total, pending: nested.pending };
        },
      },
      {
        shape: 'AddBody',
        note: '`each` gained a default, and `raw` became `keepRaw`.',
        forward: (value) => {
          const { raw, ...rest } = value;
          return raw === undefined ? value : { ...rest, keepRaw: raw };
        },
        backward: (value) => {
          const { keepRaw, ...rest } = value;
          return keepRaw === undefined ? value : { ...rest, raw: keepRaw };
        },
      },
    ],
  },
];

const changeset = new Changeset(RELEASES);

function omit(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

describe('the shape of a changeset', () => {
  it('knows its ends', () => {
    expect(changeset.oldest).toBe('2026-01-01');
    expect(changeset.latest).toBe('2026-03-01');
    expect(changeset.versions).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('names a version it does not have, and what it does have', () => {
    expect(() => changeset.parse('2026-01-02')).toThrow(UnknownVersion);
    try {
      changeset.parse('2026-01-02');
    } catch (error) {
      expect((error as UnknownVersion).available).toEqual(changeset.versions);
      expect((error as Error).message).toContain('2026-03-01');
    }
  });

  it('reports which shapes anything touches', () => {
    expect(changeset.shapes()).toEqual(['AddBody', 'TableInfo']);
  });

  it('reads its changelog newest first', () => {
    const log = changeset.changelog();
    expect(log[0]?.version).toBe('2026-03-01');
    expect(log[0]?.changes).toHaveLength(2);
    expect(log[2]?.changes).toEqual([]);
  });
});

describe('serving the newest version', () => {
  it('transforms nothing, and does not even copy', () => {
    const body = { table: 'files', each: '$.files[*]' };
    // Identity by reference: the overwhelmingly common request should cost
    // nothing at all, and asserting the reference is how that stays true.
    expect(changeset.forward('AddBody', body, '2026-03-01')).toBe(body);
    expect(changeset.backward('AddBody', body, '2026-03-01')).toBe(body);
    expect(changeset.isCurrent('2026-03-01')).toBe(true);
  });
});

describe('a request from an old caller', () => {
  it('is migrated up through every release after theirs, in order', () => {
    const asWritten = { table: 'files', rows: '$.files[*]', raw: true };

    expect(changeset.forward('AddBody', asWritten, '2026-01-01')).toEqual({
      table: 'files',
      each: '$.files[*]',
      keepRaw: true,
    });
  });

  it('starts strictly after the caller’s own version', () => {
    // Someone on 2026-02-01 already writes `each`; only the later rename applies.
    expect(changeset.forward('AddBody', { each: '$.a[*]', raw: false }, '2026-02-01')).toEqual({
      each: '$.a[*]',
      keepRaw: false,
    });
  });

  it('leaves a shape no release touches alone', () => {
    const untouched = { sql: 'SELECT 1' };
    expect(changeset.forward('QueryBody', untouched, '2026-01-01')).toBe(untouched);
  });
});

describe('a response to an old caller', () => {
  it('is rendered back down, newest release undone first', () => {
    const current = { name: 'files', rows: { total: 40, pending: 3 } };

    expect(changeset.backward('TableInfo', current, '2026-01-01')).toEqual({
      name: 'files',
      rows: 40,
      pending: 3,
    });
  });

  it('undoes two changes to one shape in the reverse of the order they were applied', () => {
    // Both AddBody changes are on the way down; applying them in declaration
    // order would undo the wrong one first and leave `rows` unset.
    const current = { table: 'files', each: '$.a[*]', keepRaw: true };
    expect(changeset.backward('AddBody', current, '2026-01-01')).toEqual({
      table: 'files',
      rows: '$.a[*]',
      raw: true,
    });
  });
});

describe('the round trip', () => {
  it('returns a caller exactly the shape they sent', () => {
    // The property that matters most: whatever a caller writes, migrating it up
    // and rendering it back down is the identity. A pair of transforms that
    // does not satisfy this is a version that silently rewrites requests.
    for (const version of changeset.versions) {
      const original = { table: 'files', rows: '$.files[*]', raw: true };
      const asWritten =
        version === '2026-01-01'
          ? original
          : version === '2026-02-01'
            ? { table: 'files', each: '$.files[*]', raw: true }
            : { table: 'files', each: '$.files[*]', keepRaw: true };

      const up = changeset.forward('AddBody', asWritten, version);
      expect(changeset.backward('AddBody', up, version)).toEqual(asWritten);
    }
  });
});

describe('a changeset that is wrong', () => {
  const bad = (releases: readonly Release[]) => () => new Changeset(releases);
  const ok = { version: '2026-01-01', summary: 'first', changes: [] };

  it('refuses to be empty', () => {
    expect(bad([])).toThrow(MalformedChangeset);
  });

  it('refuses a version that is not a real, zero-padded date', () => {
    for (const version of ['v2', '2026-1-1', '2026-02-30', '26-01-01', 'latest']) {
      expect(bad([{ version, summary: 'x', changes: [] }])).toThrow(/not a version/);
    }
  });

  it('refuses releases listed out of order', () => {
    // Lexicographic order is chronological order for this format, and the
    // chains are built by comparing — a list out of order serves wrong shapes
    // rather than failing, so it has to fail here.
    expect(
      bad([
        ok,
        { version: '2027-01-01', summary: 'x', changes: [] },
        { version: '2026-06-01', summary: 'y', changes: [] },
      ]),
    ).toThrow(/oldest first/);
  });

  it('refuses the same version twice', () => {
    expect(bad([ok, { ...ok }])).toThrow(/declared twice/);
  });

  it('refuses a baseline that claims to change something', () => {
    // Nothing is older, so its transforms could never run — which means
    // somebody has described a change against the wrong release.
    expect(
      bad([
        {
          version: '2026-01-01',
          summary: 'x',
          changes: [{ shape: 'A', note: 'n', forward: (v) => v }],
        },
      ]),
    ).toThrow(/baseline/);
  });

  it('refuses a change that transforms nothing', () => {
    expect(
      bad([ok, { version: '2026-06-01', summary: 'x', changes: [{ shape: 'A', note: 'n' }] }]),
    ).toThrow(/transforms nothing/);
  });

  it('refuses a change with no note, and a release with no summary', () => {
    expect(
      bad([
        ok,
        {
          version: '2026-06-01',
          summary: 'x',
          changes: [{ shape: 'A', note: '  ', forward: (v) => v }],
        },
      ]),
    ).toThrow(/no note/);
    expect(bad([{ version: '2026-01-01', summary: '  ', changes: [] }])).toThrow(/no summary/);
  });
});
