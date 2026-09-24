import { describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { RowMapping } from '../../src/contexts/records/domain/row-mapping.vo.js';
import { coerce } from '../../src/contexts/records/domain/coercion.js';
import { parsePath, readPath } from '../../src/contexts/records/domain/json-path.js';

/** The mapping DSL: where a caller's mistakes surface, so refusing well is the point. */
const context = {
  rowId: () => 'row_fixed',
  at: new Date('2026-08-26T09:00:00Z'),
  batch: 'batch_1',
};

describe('paths', () => {
  it('walks keys and indexes', () => {
    const blob = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(readPath(blob, parsePath('$.a.b[1].c', 'x'))).toBe(2);
  });

  it('reads a missing step as nothing rather than throwing', () => {
    // A missing field reads null; throwing would make it a failed write.
    expect(readPath({ a: {} }, parsePath('$.a.b.c', 'x'))).toBeUndefined();
  });

  it('refuses [*] outside a fan-out', () => {
    expect(() => parsePath('$.files[*]', 'column "x".from')).toThrow(/must resolve to one value/);
    expect(() => parsePath('$.files[*]', 'rows', true)).not.toThrow();
  });

  it('refuses a path that is not one', () => {
    expect(() => parsePath('files.name', 'rows')).toThrow(/must start with/);
    expect(() => parsePath('$.a[', 'rows')).toThrow(/bad subscript/);
  });

  /**
   * Quoted subscripts reach keys the dotted form can't spell (`Invoice #`,
   * `Total (USD)`) — JSONPath's own escape hatch.
   */
  it('reaches a key the dotted form cannot spell', () => {
    const blob = { 'Invoice #': 'ACME-4471', 'Total (USD)': 18400 };

    expect(readPath(blob, parsePath('$["Invoice #"]', 'x'))).toBe('ACME-4471');
    expect(readPath(blob, parsePath("$['Total (USD)']", 'x'))).toBe(18400);
  });

  it('keeps a quoted key and a numeric index apart', () => {
    // An object key `"0"` and an array index `0` are different reachable things.
    expect(readPath({ '0': 'by key' }, parsePath('$["0"]', 'x'))).toBe('by key');
    expect(readPath(['by index'], parsePath('$[0]', 'x'))).toBe('by index');
  });

  it('unescapes inside a quoted key, and refuses an empty one', () => {
    expect(readPath({ 'a"b': 1 }, parsePath('$["a\\"b"]', 'x'))).toBe(1);
    expect(() => parsePath('$[""]', 'x')).toThrow(/empty quoted key/);
  });

  it('mixes quoted keys with the rest of the grammar', () => {
    const blob = { rows: [{ 'Ship Date': '2026-03-01' }] };

    expect(readPath(blob, parsePath('$.rows[0]["Ship Date"]', 'x'))).toBe('2026-03-01');
  });
});

describe('coercion', () => {
  it('accepts the obvious conversions', () => {
    expect(coerce(42, ColumnType.Integer, 'n')).toBe(42);
    expect(coerce('42', ColumnType.Integer, 'n')).toBe(42);
    expect(coerce(1, ColumnType.Boolean, 'b')).toBe(true);
    expect(coerce('2026-08-26T09:00:00Z', ColumnType.Date, 'd')).toBe('2026-08-26');
  });

  it('reads absent and null as null', () => {
    expect(coerce(undefined, ColumnType.Integer, 'n')).toBeNull();
    expect(coerce(null, ColumnType.Varchar, 's')).toBeNull();
  });

  it('refuses a float in an integer column, and says what to declare instead', () => {
    expect(() => coerce(1.5, ColumnType.Integer, 'n')).toThrow(/declare it DOUBLE/);
  });

  it('refuses an integer that does not fit, and says what to declare instead', () => {
    expect(() => coerce(3_000_000_000, ColumnType.Integer, 'n')).toThrow(/declare it BIGINT/);
    expect(coerce(3_000_000_000, ColumnType.BigInt, 'n')).toBe(3_000_000_000);
  });

  it('refuses an object in a text column rather than stringifying it', () => {
    // Silently stringifying would hide surprises until a later query.
    expect(() => coerce({ a: 1 }, ColumnType.Varchar, 's')).toThrow(/declare this column JSON/);
    expect(coerce({ a: 1 }, ColumnType.Json, 's')).toBe('{"a":1}');
  });

  it('does not echo a whole tool result back in the error', () => {
    const enormous = 'x'.repeat(5_000);
    try {
      coerce(enormous, ColumnType.Integer, 'n');
      throw new Error('should have refused');
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('a mapping', () => {
  const body = {
    table: 'files',
    rows: '$.files[*]',
    columns: {
      pr: { from: '$$.number', type: ColumnType.Integer },
      path: { from: '$.name', type: ColumnType.Varchar },
      tag: { value: 'imported', type: ColumnType.Varchar },
    },
    result: { number: 7, files: [{ name: 'a.ts' }, { name: 'b.ts' }] },
  };

  it('fans an array out into one row each', () => {
    const applied = RowMapping.parse(body).apply(body.result, context);
    expect(applied.rows).toHaveLength(2);
    expect(applied.rows.map((row) => row.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('carries a $$ path from the parent onto every row', () => {
    const applied = RowMapping.parse(body).apply(body.result, context);
    expect(applied.rows.every((row) => row.pr === 7)).toBe(true);
  });

  it('puts the system columns on every row', () => {
    const [row] = RowMapping.parse(body).apply(body.result, context).rows;
    expect(row).toMatchObject({
      _row_id: 'row_fixed',
      _ingested_at: '2026-08-26T09:00:00.000Z',
      _batch: 'batch_1',
    });
  });

  it('refuses a column with both a path and a constant', () => {
    expect(() =>
      RowMapping.parse({
        ...body,
        columns: { x: { from: '$.a', value: 'b', type: ColumnType.Varchar } },
      }),
    ).toThrow(/exactly one of/);
  });

  it('refuses a column with neither', () => {
    expect(() =>
      RowMapping.parse({ ...body, columns: { x: { type: ColumnType.Varchar } } }),
    ).toThrow(/exactly one of/);
  });

  it('refuses a caller declaring a reserved column', () => {
    expect(() =>
      RowMapping.parse({
        ...body,
        columns: { _row_id: { from: '$.name', type: ColumnType.Varchar } },
      }),
    ).toThrow(/keeps for/);
  });

  it('refuses a column name that is not safe in generated SQL', () => {
    for (const name of ['drop"table', 'a-b', 'a b', '1st']) {
      expect(() =>
        RowMapping.parse({
          ...body,
          columns: { [name]: { from: '$.n', type: ColumnType.Varchar } },
        }),
      ).toThrow();
    }
  });

  it('refuses embedding a column that holds no text', () => {
    expect(() =>
      RowMapping.parse({
        ...body,
        columns: { n: { from: '$.n', type: ColumnType.Integer, embed: true } },
      }),
    ).toThrow(/only VARCHAR columns/);
  });

  it('refuses a fan-out that does not point at an array', () => {
    expect(() =>
      RowMapping.parse({ ...body, rows: '$.number' }).apply(body.result, context),
    ).toThrow(/does not point at an array/);
  });

  it('refuses more rows than one call may write', () => {
    const many = { number: 1, files: Array.from({ length: 10_001 }, (_, n) => ({ name: `${n}` })) };
    expect(() => RowMapping.parse(body).apply(many, context)).toThrow(/at most 10000/);
  });
});
