import { describe, expect, it } from 'bun:test';
import { formatWire } from '../src/docs/format-wire';
import { ENDPOINTS } from '../src/docs/reference';
import { COMBINED, FEATURES } from '../src/features/features';

/**
 * The layout rules, and the two promises that matter more than any of them:
 * a sample this cannot read comes back byte for byte, and one it can read
 * still says the same thing afterwards.
 */

/** The width in `format-wire.ts`, plus the closing punctuation it hugs. */
const LIMIT = 71;

/** Every JSON-bearing sample the site renders, by the name it is written under. */
function samples(): [string, string][] {
  const found: [string, string][] = [];

  for (const feature of [...FEATURES, COMBINED]) {
    found.push([`${feature.id}.request`, feature.request]);
    found.push([`${feature.id}.response`, feature.response]);
  }
  for (const endpoint of ENDPOINTS) {
    if (endpoint.sample) found.push([endpoint.id, endpoint.sample]);
  }
  return found;
}

/**
 * Strings, atoms and punctuation in order — what a re-lay may not change.
 *
 * The left edge inside a multi-line string does move, by design: the SQL in a
 * receipt travels with the key it hangs off. Only its line breaks are held.
 */
function tokens(text: string): string[] {
  const found = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,"]+/g) ?? [];
  return found.map((token) => token.replace(/\n[ \t]*/g, '\n'));
}

describe('formatting a document', () => {
  it('hangs the members of an object under its first key', () => {
    const wide = '{ "alpha": "one", "bravo": "two", "charlie": "three", "delta": "four" }';
    expect(formatWire(wide)).toBe(
      '{ "alpha": "one",\n  "bravo": "two",\n  "charlie": "three",\n  "delta": "four" }',
    );
  });

  it('leaves a short document on one line', () => {
    expect(formatWire('{\n  "label": "staging-agent"\n}')).toBe('{ "label": "staging-agent" }');
  });

  it('gives an array of objects a line each, from the left', () => {
    const rows = '{ "rows": [{ "id": "a" }, { "id": "b" }, { "id": "c" }, { "id": "dddddddd" }] }';
    expect(formatWire(rows)).toBe(
      '{ "rows": [\n    { "id": "a" },\n    { "id": "b" },\n    { "id": "c" },\n    { "id": "dddddddd" } ] }',
    );
  });

  it('drops a value under its key rather than breaking it', () => {
    const url = `{ "headers": { "endpoint": "https://example.test/${'p'.repeat(40)}" } }`;
    expect(formatWire(url)).toContain('"endpoint":\n');
    expect(formatWire(url)).toContain(`https://example.test/${'p'.repeat(40)}`);
  });

  it('moves a multi-line string with the key it belongs to', () => {
    expect(formatWire('{ "x": 1,\n  "sql": "SELECT a\n   FROM b" }')).toBe(
      '{ "x": 1,\n  "sql": "SELECT a\n          FROM b" }',
    );
  });

  it('keeps an empty group as it found it', () => {
    expect(formatWire('{ "a": {}, "b": [] }')).toBe('{ "a": {}, "b": [] }');
  });
});

describe('what it will not touch', () => {
  it('passes through a document that does not start its line', () => {
    const curl = `-F 'body={ "chunkTokens": 800,\n           "overlapTokens": 120 }'`;
    expect(formatWire(curl)).toBe(curl);
  });

  it('passes through an unbalanced document', () => {
    expect(formatWire('{ "a": 1,\n  "b": ')).toBe('{ "a": 1,\n  "b": ');
  });

  it('keeps the transcript around a document', () => {
    const out = formatWire('POST /x\n{ "a": 1 }\n\n200 OK\n# then\n{ "b": 2 }');
    expect(out).toBe('POST /x\n{ "a": 1 }\n\n200 OK\n# then\n{ "b": 2 }');
  });
});

describe('every sample on the site', () => {
  it('says the same thing after formatting as before', () => {
    for (const [name, sample] of samples()) {
      expect([name, tokens(formatWire(sample))]).toEqual([name, tokens(sample)]);
    }
  });

  it('settles — formatting twice changes nothing more', () => {
    for (const [name, sample] of samples()) {
      const once = formatWire(sample);
      expect([name, formatWire(once)]).toEqual([name, once]);
    }
  });

  it('stays inside the width the panes were built for', () => {
    const over = samples().flatMap(([name, sample]) =>
      formatWire(sample)
        .split('\n')
        .filter((line) => line.length > LIMIT)
        .map((line) => `${name}: ${line.length} — ${line}`),
    );
    expect(over).toEqual([]);
  });
});
