import 'reflect-metadata';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { viewParity } from '../support/view-parity.js';

describe('a view and a copy, on local disk', () => {
  const parity = viewParity({ cache: false });
  beforeAll(parity.open);
  afterAll(parity.close);
  for (const [name, step] of parity.steps) it(name, step);
});
