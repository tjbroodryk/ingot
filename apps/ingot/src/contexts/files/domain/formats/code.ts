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

// The language grammars from tree-sitter packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languages = new Map<MediaType, any>([
  [MediaType.JavaScript, JavaScript],
  [MediaType.TypeScript, TypeScript.typescript],
  [MediaType.Python, Python],
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
 * Builds blocks from extracted symbols.
 *
 * The preamble (imports, module-level code before the first symbol) becomes
 * a block with heading ["preamble"]. Each symbol becomes a block with heading
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

  // Each symbol becomes a block
  for (const sym of sorted) {
    const text = lines.slice(sym.startLine, sym.endLine + 1).join('\n').trim();
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

  return blocks;
}

async function parseCode(input: ParseInput): Promise<ParsedDocument> {
  const language = languages.get(input.mediaType);
  if (!language) {
    throw new Error(`No tree-sitter language for ${input.mediaType}`);
  }

  const parser = new Parser();
  parser.setLanguage(language);

  const source = decodeText(input.content);
  const tree = parser.parse(source);

  const extractSymbols =
    input.mediaType === MediaType.Python ? extractPySymbols : extractJsSymbols;
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
