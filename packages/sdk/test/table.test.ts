import { describe, expect, it } from 'bun:test';
import { ColumnType, type Infer, col, table } from '../src/index.js';
import { client, json } from './support.js';

describe('table definitions', () => {
  const base = table('tickets').columns({
    id: col.varchar('$.id'),
    priority: col.integer('$.priority'),
    count: col.bigint('$.count'),
    openedAt: col.timestamp('$.opened_at'),
    labels: col.json('$.labels'),
  });

  it('are immutable, so a base can be extended', () => {
    const extended = base
      .columns({ title: col.varchar('$.title').embed() })
      .key('id')
      .raw();
    expect(Object.keys(base.toJSON().columns)).toEqual([
      'id',
      'priority',
      'count',
      'openedAt',
      'labels',
    ]);
    expect(extended.toJSON()).toMatchObject({ key: ['id'], raw: true });
    expect(extended.toJSON().columns.title).toEqual({
      type: ColumnType.Varchar,
      from: '$.title',
      embed: true,
    });
    expect(base.toJSON().raw).toBeUndefined();
  });

  it('keep describe out of the /add mapping but in the extraction', () => {
    const def = table('contracts').columns({
      party: col.varchar('$.party').describe('Who signed'),
    });
    expect(def.toJSON().columns.party).toEqual({ type: ColumnType.Varchar, from: '$.party' });
    expect(def.toExtraction().columns.party).toEqual({
      type: ColumnType.Varchar,
      from: '$.party',
      describe: 'Who signed',
    });
  });

  it('carry a constant of null', () => {
    expect(col.integer.value(null).toJSON()).toEqual({ type: ColumnType.Integer, value: null });
  });

  it('type rows as /query renders them', () => {
    const row: Infer<typeof base> = {
      id: 'T-1',
      priority: 2,
      count: '9007199254740993',
      openedAt: '2026-09-17 10:11:12.345',
      labels: '["bug"]',
      _row_id: 'r',
      _ingested_at: '2026-09-17 10:11:12.345',
      _batch: 'b',
    };
    expect(row.count).toBeString();
  });

  it('are checked at the type level', async () => {
    // @ts-expect-error — only varchar columns can be embedded
    col.integer('$.n').embed;

    // @ts-expect-error — key names must be declared columns
    base.key('nope');

    const { foundry } = client(() => json({}));
    const ingot = foundry.ingot('ing_1');
    const extractOnly = table('contracts').columns({ notice: col.integer().describe('days') });
    // @ts-expect-error — a model-only column cannot be filled by /add
    void ingot.add(extractOnly, {}).catch(() => {});

    const typed = ingot.table(base.columns({ title: col.varchar('$.t').embed() }));
    // @ts-expect-error — `priority` is not embedded
    void typed.search('x', { column: 'priority' }).catch(() => {});
    void typed.search('x', { column: 'title' }).catch(() => {});
  });
});
