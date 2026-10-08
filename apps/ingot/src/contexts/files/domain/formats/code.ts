import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import {
  Boundary,
  ByteShape,
  type Block,
  BlockKind,
  type FormatHandler,
  type ParseInput,
  type ParsedDocument,
} from '../format.js';
import { MediaType } from '../media-type.js';
import { decodeText } from './blocks.js';

type SyntaxNode = Parser.SyntaxNode;

// The Kotlin package's own loader looks for `tree-sitter-kotlin.node` under Bun,
// but its prebuilds are named after the scoped package, so it never finds them.
// node-gyp-build matches the prebuild by platform rather than by file name.
const Kotlin = require('node-gyp-build')(
  require
    .resolve('@tree-sitter-grammars/tree-sitter-kotlin/package.json')
    .replace(/package\.json$/, ''),
);

// The language grammars from tree-sitter packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languages = new Map<MediaType, any>([
  [MediaType.JavaScript, JavaScript],
  [MediaType.TypeScript, TypeScript.typescript],
  [MediaType.Python, Python],
  [MediaType.Kotlin, Kotlin],
]);

interface Symbol {
  name: string;
  /** For methods, the parent class name */
  parent: string | null;
  startLine: number;
  endLine: number;
}

/**
 * Extracts top-level symbols from a JavaScript/TypeScript AST.
 *
 * Looks for function declarations, class declarations (and their methods),
 * and variable declarations that hold arrow functions or function expressions.
 */
function extractJsSymbols(root: SyntaxNode): Symbol[] {
  const symbols: Symbol[] = [];

  function visit(node: SyntaxNode, parentClass: string | null = null): void {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        symbols.push({
          name,
          parent: parentClass,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
        });
        break;
      }

      case 'class_declaration': {
        const className = node.childForFieldName('name')?.text ?? 'anonymous';
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.children) {
            if (child.type === 'method_definition' || child.type === 'field_definition') {
              visit(child, className);
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        symbols.push({
          name,
          parent: parentClass,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
        });
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // const foo = () => {} or const foo = function() {}
        for (const child of node.children) {
          if (child.type === 'variable_declarator') {
            const name = child.childForFieldName('name')?.text;
            const value = child.childForFieldName('value');
            if (
              name &&
              value &&
              (value.type === 'arrow_function' || value.type === 'function_expression')
            ) {
              symbols.push({
                name,
                parent: null,
                startLine: node.startPosition.row,
                endLine: node.endPosition.row,
              });
            }
          }
        }
        break;
      }

      case 'export_statement': {
        // export function foo() {} or export const foo = () => {}
        for (const child of node.children) {
          visit(child, parentClass);
        }
        break;
      }

      default:
        // Only recurse into program-level nodes to avoid entering function bodies
        if (node.type === 'program') {
          for (const child of node.children) {
            visit(child, null);
          }
        }
    }
  }

  visit(root, null);
  return symbols;
}

/**
 * Extracts top-level symbols from a Python AST.
 *
 * Looks for function definitions and class definitions (and their methods).
 */
function extractPySymbols(root: SyntaxNode): Symbol[] {
  const symbols: Symbol[] = [];

  function visit(node: SyntaxNode, parentClass: string | null = null): void {
    switch (node.type) {
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        symbols.push({
          name,
          parent: parentClass,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
        });
        break;
      }

      case 'class_definition': {
        const className = node.childForFieldName('name')?.text ?? 'anonymous';
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.children) {
            if (child.type === 'function_definition' || child.type === 'decorated_definition') {
              visit(child, className);
            }
          }
        }
        break;
      }

      case 'decorated_definition': {
        // Handle @decorator\ndef foo(): or @decorator\nclass Foo:
        for (const child of node.children) {
          if (child.type === 'function_definition' || child.type === 'class_definition') {
            // Include decorators in the range
            const name = child.childForFieldName('name')?.text ?? 'anonymous';
            if (child.type === 'function_definition') {
              symbols.push({
                name,
                parent: parentClass,
                startLine: node.startPosition.row,
                endLine: node.endPosition.row,
              });
            } else {
              // class - recurse into it
              const className = name;
              const body = child.childForFieldName('body');
              if (body) {
                for (const member of body.children) {
                  if (member.type === 'function_definition' || member.type === 'decorated_definition') {
                    visit(member, className);
                  }
                }
              }
            }
          }
        }
        break;
      }

      default:
        if (node.type === 'module') {
          for (const child of node.children) {
            visit(child, null);
          }
        }
    }
  }

  visit(root, null);
  return symbols;
}

/**
 * Extracts symbols from a Kotlin AST.
 *
 * Functions, secondary constructors, and properties holding a lambda or
 * anonymous function. Classes, objects and companions nest, so a member's
 * parent is a dotted path like "Calc.Companion".
 */
function extractKtSymbols(root: SyntaxNode): Symbol[] {
  const symbols: Symbol[] = [];

  function push(node: SyntaxNode, name: string, parent: string | null): void {
    symbols.push({
      name,
      parent,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    });
  }

  function visit(node: SyntaxNode, parent: string | null): void {
    switch (node.type) {
      case 'function_declaration':
        push(node, node.childForFieldName('name')?.text ?? 'anonymous', parent);
        break;

      case 'secondary_constructor':
        if (parent) push(node, 'constructor', parent);
        break;

      case 'class_declaration':
      case 'object_declaration':
      case 'companion_object': {
        // An unnamed companion is `Companion` in Kotlin itself
        const fallback = node.type === 'companion_object' ? 'Companion' : 'anonymous';
        const name = node.childForFieldName('name')?.text ?? fallback;
        const path = parent ? `${parent}.${name}` : name;
        const body = node.namedChildren.find(
          (child) => child.type === 'class_body' || child.type === 'enum_class_body',
        );
        for (const member of body?.namedChildren ?? []) {
          visit(member, path);
        }
        break;
      }

      case 'property_declaration': {
        // val handler = { ... } or val f = fun() {}
        const value = node.namedChildren.find(
          (child) => child.type === 'lambda_literal' || child.type === 'anonymous_function',
        );
        const name = node.namedChildren
          .find((child) => child.type === 'variable_declaration')
          ?.namedChildren.find((child) => child.type === 'identifier')?.text;
        if (name && value) push(node, name, parent);
        break;
      }

      case 'source_file':
        for (const child of node.namedChildren) {
          visit(child, null);
        }
    }
  }

  visit(root, null);
  return symbols;
}

const extractors = new Map<MediaType, (root: SyntaxNode) => Symbol[]>([
  [MediaType.JavaScript, extractJsSymbols],
  [MediaType.TypeScript, extractJsSymbols],
  [MediaType.Python, extractPySymbols],
  [MediaType.Kotlin, extractKtSymbols],
]);

/**
 * Builds blocks from extracted symbols.
 *
 * The preamble (imports, module-level code before the first symbol) becomes
 * a block with heading ["preamble"], and code after the last symbol one with
 * ["epilogue"]. Each symbol becomes a block with heading
 * ["ClassName", "methodName"] or just ["functionName"].
 */
function buildBlocks(source: string, symbols: Symbol[]): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];

  // Sort symbols by start line
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);

  // Find preamble: everything before the first symbol
  const firstSymbolLine = sorted.length > 0 ? sorted[0]!.startLine : lines.length;
  if (firstSymbolLine > 0) {
    const preambleText = lines.slice(0, firstSymbolLine).join('\n').trim();
    if (preambleText.length > 0) {
      blocks.push({
        text: preambleText,
        page: null,
        headings: ['preamble'],
        hard: false,
        kind: BlockKind.Code,
      });
    }
  }

  // Each symbol's block starts where the previous one ended, so code between
  // symbols (constants, method-less classes, doc comments) leads into the next
  // symbol rather than being dropped. A symbol on lines already taken, like a
  // second declarator in the same `const`, is part of the block before it.
  let cursor = firstSymbolLine;
  for (const sym of sorted) {
    if (sym.endLine < cursor) continue;

    const text = lines
      .slice(cursor, sym.endLine + 1)
      .join('\n')
      .trim();
    cursor = sym.endLine + 1;
    if (text.length === 0) continue;

    const headings = sym.parent ? [sym.parent, sym.name] : [sym.name];

    blocks.push({
      text,
      page: null,
      headings,
      hard: false,
      kind: BlockKind.Code,
    });
  }

  // Code after the last symbol, unless it only closes the enclosing class
  const epilogueText = lines.slice(cursor).join('\n').trim();
  if (sorted.length > 0 && /[^\s})\];]/.test(epilogueText)) {
    blocks.push({
      text: epilogueText,
      page: null,
      headings: ['epilogue'],
      hard: false,
      kind: BlockKind.Code,
    });
  }

  return blocks;
}

async function parseCode(input: ParseInput): Promise<ParsedDocument> {
  const language = languages.get(input.mediaType);
  const extractSymbols = extractors.get(input.mediaType);
  if (!language || !extractSymbols) {
    throw new Error(`No tree-sitter language for ${input.mediaType}`);
  }

  const parser = new Parser();
  parser.setLanguage(language);

  const source = decodeText(input.content);
  const tree = parser.parse(source);

  const symbols = extractSymbols(tree.rootNode);

  const blocks = buildBlocks(source, symbols);

  // Title: the first non-preamble symbol, or null
  const firstSymbol = symbols.find((s) => s.name !== 'preamble');
  const title = firstSymbol?.parent
    ? `${firstSymbol.parent}.${firstSymbol.name}`
    : firstSymbol?.name ?? null;

  return {
    blocks,
    pages: null,
    title,
    rows: null,
  };
}

/**
 * JavaScript: functions, classes, methods as semantic boundaries.
 */
export const javascriptHandler: FormatHandler = {
  mediaType: MediaType.JavaScript,
  extensions: ['js', 'mjs', 'cjs', 'jsx'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },
  parse: parseCode,
};

/**
 * TypeScript: same structure as JavaScript, with type annotations.
 */
export const typescriptHandler: FormatHandler = {
  mediaType: MediaType.TypeScript,
  extensions: ['ts', 'mts', 'cts', 'tsx'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },
  parse: parseCode,
};

/**
 * Python: functions, classes, methods, with decorator support.
 */
export const pythonHandler: FormatHandler = {
  mediaType: MediaType.Python,
  extensions: ['py', 'pyw', 'pyi'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },
  parse: parseCode,
};

/**
 * Kotlin: functions, classes, objects and companions, including scripts.
 */
export const kotlinHandler: FormatHandler = {
  mediaType: MediaType.Kotlin,
  extensions: ['kt', 'kts'],
  shape: ByteShape.Text,
  tabular: false,
  chunking: { boundary: Boundary.Heading, overlap: true, carryHeadings: true },
  parse: parseCode,
};
