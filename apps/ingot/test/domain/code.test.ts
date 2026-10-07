import { describe, expect, it } from 'bun:test';
import { BlockKind, Boundary } from '../../src/contexts/files/domain/format.js';
import { MediaType } from '../../src/contexts/files/domain/media-type.js';
import {
  javascriptHandler,
  typescriptHandler,
  pythonHandler,
} from '../../src/contexts/files/domain/formats/code.js';

const readJs = (code: string) =>
  javascriptHandler.parse({
    content: Buffer.from(code),
    filename: 'test.js',
    mediaType: MediaType.JavaScript,
  });

const readTs = (code: string) =>
  typescriptHandler.parse({
    content: Buffer.from(code),
    filename: 'test.ts',
    mediaType: MediaType.TypeScript,
  });

const readPy = (code: string) =>
  pythonHandler.parse({
    content: Buffer.from(code),
    filename: 'test.py',
    mediaType: MediaType.Python,
  });

describe('JavaScript/TypeScript code parsing', () => {
  it('extracts a function declaration', async () => {
    const parsed = await readJs(`
function greet(name) {
  return 'Hello, ' + name;
}
`);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual(['greet']);
    expect(parsed.blocks[0]?.text).toContain('function greet');
    expect(parsed.blocks[0]?.kind).toBe(BlockKind.Code);
  });

  it('extracts an arrow function assigned to const', async () => {
    const parsed = await readJs(`
const add = (a, b) => {
  return a + b;
};
`);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual(['add']);
  });

  it('extracts class methods separately', async () => {
    const parsed = await readJs(`
class Calculator {
  add(a, b) {
    return a + b;
  }

  subtract(a, b) {
    return a - b;
  }
}
`);

    // Class declaration becomes preamble, methods are separate blocks
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[0]?.text).toContain('class Calculator');
    expect(parsed.blocks[1]?.headings).toEqual(['Calculator', 'add']);
    expect(parsed.blocks[2]?.headings).toEqual(['Calculator', 'subtract']);
  });

  it('groups imports into preamble', async () => {
    const parsed = await readJs(`
import { foo } from './foo';
import { bar } from './bar';

function doSomething() {
  return foo() + bar();
}
`);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[0]?.text).toContain("import { foo }");
    expect(parsed.blocks[0]?.text).toContain("import { bar }");
    expect(parsed.blocks[1]?.headings).toEqual(['doSomething']);
  });

  it('handles exported functions', async () => {
    const parsed = await readJs(`
export function publicFn() {
  return 'public';
}

export const arrowFn = () => 'arrow';
`);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.headings).toEqual(['publicFn']);
    expect(parsed.blocks[1]?.headings).toEqual(['arrowFn']);
  });

  it('handles TypeScript with types', async () => {
    const parsed = await readTs(`
interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  return \`Hello, \${user.name}\`;
}
`);

    // Interface goes into preamble, function is separate
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[0]?.text).toContain('interface User');
    expect(parsed.blocks[1]?.headings).toEqual(['greet']);
  });

  it('handles empty file gracefully', async () => {
    const parsed = await readJs('');

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.title).toBeNull();
  });

  it('handles file with only comments as preamble', async () => {
    const parsed = await readJs(`
// This is a comment
/* Another comment */
`);

    // Comments without any functions are still captured as preamble
    // since they may contain meaningful documentation
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
  });

  it('sets title to first function name', async () => {
    const parsed = await readJs(`
function main() {}
function helper() {}
`);

    expect(parsed.title).toBe('main');
  });

  it('sets title to ClassName.methodName for class methods', async () => {
    const parsed = await readJs(`
class Service {
  init() {}
}
`);

    expect(parsed.title).toBe('Service.init');
  });
});

describe('Python code parsing', () => {
  it('extracts a function definition', async () => {
    const parsed = await readPy(`
def greet(name):
    return f'Hello, {name}'
`);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual(['greet']);
    expect(parsed.blocks[0]?.text).toContain('def greet');
    expect(parsed.blocks[0]?.kind).toBe(BlockKind.Code);
  });

  it('extracts class methods separately', async () => {
    const parsed = await readPy(`
class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
`);

    // Class declaration becomes preamble, methods are separate blocks
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[0]?.text).toContain('class Calculator');
    expect(parsed.blocks[1]?.headings).toEqual(['Calculator', 'add']);
    expect(parsed.blocks[2]?.headings).toEqual(['Calculator', 'subtract']);
  });

  it('groups imports into preamble', async () => {
    const parsed = await readPy(`
import os
from typing import List

def main():
    pass
`);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[0]?.text).toContain('import os');
    expect(parsed.blocks[1]?.headings).toEqual(['main']);
  });

  it('handles decorated functions', async () => {
    const parsed = await readPy(`
@decorator
def decorated_fn():
    pass
`);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.headings).toEqual(['decorated_fn']);
    expect(parsed.blocks[0]?.text).toContain('@decorator');
  });

  it('handles decorated class methods', async () => {
    const parsed = await readPy(`
class Service:
    @staticmethod
    def static_method():
        pass

    @classmethod
    def class_method(cls):
        pass
`);

    // Class declaration + 2 decorated methods
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.headings).toEqual(['preamble']);
    expect(parsed.blocks[1]?.headings).toEqual(['Service', 'static_method']);
    expect(parsed.blocks[1]?.text).toContain('@staticmethod');
    expect(parsed.blocks[2]?.headings).toEqual(['Service', 'class_method']);
  });

  it('handles empty file gracefully', async () => {
    const parsed = await readPy('');

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.title).toBeNull();
  });

  it('sets title to first function name', async () => {
    const parsed = await readPy(`
def main():
    pass

def helper():
    pass
`);

    expect(parsed.title).toBe('main');
  });
});

describe('code handler properties', () => {
  it('JavaScript uses Heading boundary with overlap', () => {
    expect(javascriptHandler.chunking.boundary).toBe(Boundary.Heading);
    expect(javascriptHandler.chunking.overlap).toBe(true);
    expect(javascriptHandler.chunking.carryHeadings).toBe(true);
  });

  it('TypeScript uses Heading boundary with overlap', () => {
    expect(typescriptHandler.chunking.boundary).toBe(Boundary.Heading);
    expect(typescriptHandler.chunking.overlap).toBe(true);
    expect(typescriptHandler.chunking.carryHeadings).toBe(true);
  });

  it('Python uses Heading boundary with overlap', () => {
    expect(pythonHandler.chunking.boundary).toBe(Boundary.Heading);
    expect(pythonHandler.chunking.overlap).toBe(true);
    expect(pythonHandler.chunking.carryHeadings).toBe(true);
  });

  it('all handlers have correct extensions', () => {
    expect(javascriptHandler.extensions).toContain('js');
    expect(javascriptHandler.extensions).toContain('jsx');
    expect(typescriptHandler.extensions).toContain('ts');
    expect(typescriptHandler.extensions).toContain('tsx');
    expect(pythonHandler.extensions).toContain('py');
  });

  it('all blocks are marked as code kind', async () => {
    const jsBlocks = (await readJs('function foo() {}')).blocks;
    const pyBlocks = (await readPy('def foo(): pass')).blocks;

    for (const block of [...jsBlocks, ...pyBlocks]) {
      expect(block.kind).toBe(BlockKind.Code);
    }
  });
});
