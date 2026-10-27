import { describe, expect, it } from 'bun:test';
import { ColumnType } from '@ingot/shared/ingot-v1';
import { FileMapping } from '../../src/contexts/files/domain/file-mapping.vo.js';
import { parseDelimited } from '../../src/contexts/files/domain/formats/delimited.js';
import { inferExtraction } from '../../src/contexts/files/domain/inferred-columns.js';

describe('columns inferred from a header', () => {
  const csv = [
    'Invoice #,Amount,Rate,Paid,Zip,2024 Total,amount,Big',
    'A-1,18400,0.5,true,02134,1,x,9007199254740993',
    'A-2,,1.25,false,10001,2,y,1',
  ].join('\n');

  it('names and types every header from what the rows hold', () => {
    const { extraction, rows } = inferExtraction({ table: 'invoices' }, parseDelimited(csv));

    expect(extraction.rows).toBe('$[*]');
    expect(extraction.columns).toEqual({
      invoice: { from: '$["Invoice #"]', type: ColumnType.Varchar },
      amount: { from: '$["Amount"]', type: ColumnType.Integer },
      rate: { from: '$["Rate"]', type: ColumnType.Double },
      paid: { from: '$["Paid"]', type: ColumnType.Boolean },
      // A leading zero is a code, not a number.
      zip: { from: '$["Zip"]', type: ColumnType.Varchar },
      c_2024_total: { from: '$["2024 Total"]', type: ColumnType.Integer },
      amount_2: { from: '$["amount"]', type: ColumnType.Varchar },
      // Past 2^53 it would not round-trip.
      big: { from: '$["Big"]', type: ColumnType.Varchar },
    });
    expect(rows[1]?.Amount).toBeNull();
  });

  it('produces a mapping FileMapping accepts, key included', () => {
    const { extraction } = inferExtraction(
      { table: 'invoices', key: ['invoice'] },
      parseDelimited(csv),
    );

    expect(FileMapping.parse(extraction, { tabular: true }).key).toEqual(['invoice']);
  });

  it('refuses a file with a header and nothing under it', () => {
    expect(() => inferExtraction({ table: 't' }, parseDelimited('a,b\n'))).toThrow(/no data rows/);
  });
});
