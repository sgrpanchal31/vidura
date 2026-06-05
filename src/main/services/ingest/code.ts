import { extname } from 'path'
import type { CodeSymbolUnit } from '../chunker'

// Maps file extension to tree-sitter-wasms grammar name
const GRAMMAR_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.rb': 'ruby',
}

// Node types that represent top-level symbols worth indexing as parent units.
// Keys are grammar names; values are node types to capture.
const SYMBOL_NODE_TYPES: Record<string, string[]> = {
  typescript: ['function_declaration', 'method_definition', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'export_statement'],
  tsx: ['function_declaration', 'method_definition', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'export_statement'],
  javascript: ['function_declaration', 'method_definition', 'class_declaration', 'export_statement'],
  python: ['function_definition', 'class_definition'],
  go: ['function_declaration', 'method_declaration', 'type_declaration'],
  rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item'],
  java: ['method_declaration', 'class_declaration', 'interface_declaration'],
  c: ['function_definition', 'struct_specifier'],
  cpp: ['function_definition', 'class_specifier', 'struct_specifier'],
  ruby: ['method', 'class', 'module'],
}

// In TypeScript/JS, export_statement wraps the real declaration — unwrap one level
function unwrapExport(node: any): any {
  if (node.type === 'export_statement' && node.childCount > 0) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child && child.type !== 'export' && child.type !== 'default' && child.type !== 'const' && child.type !== ';') {
        return child
      }
    }
  }
  return node
}

// Extract a human-readable name from a symbol node
function extractName(node: any, grammar: string): string {
  // Try 'name' child node first (most languages)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier')) {
      return child.text
    }
  }
  return node.type
}

// Walk tree and collect top-level symbol nodes, building class-prefixed paths
function collectSymbols(
  node: any,
  code: string,
  grammar: string,
  symbolTypes: Set<string>,
  depth: number,
  classStack: string[]
): CodeSymbolUnit[] {
  const results: CodeSymbolUnit[] = []

  // Only capture at top-level or direct method children of a class
  const effective = unwrapExport(node)
  const isSymbol = symbolTypes.has(effective.type)
  const isClass = effective.type.includes('class') || effective.type.includes('impl') || effective.type === 'module'

  if (isSymbol && depth <= 2) {
    const name = extractName(effective, grammar)
    const symbolPath = classStack.length > 0
      ? `${classStack.join(' > ')} > ${name}`
      : name

    const startLine = effective.startPosition.row + 1
    const text = code.slice(effective.startIndex, effective.endIndex)

    results.push({ parentText: text, symbolPath, startLine })

    // Recurse into classes/impls/modules to find methods — but not deeper
    if (isClass && depth === 0) {
      for (let i = 0; i < effective.childCount; i++) {
        const child = effective.child(i)
        if (child) {
          const inner = collectSymbols(child, code, grammar, symbolTypes, depth + 1, [name])
          results.push(...inner)
        }
      }
    }
    return results
  }

  // Not a symbol at this level — recurse into children at top level only
  if (depth === 0) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) {
        results.push(...collectSymbols(child, code, grammar, symbolTypes, depth, classStack))
      }
    }
  }

  return results
}

let _Parser: any = null
let _parserInitialized = false
const _languageCache = new Map<string, any>()

async function ensureParser(): Promise<any> {
  if (_parserInitialized) return _Parser
  // Dynamic import so esbuild doesn't try to statically resolve the WASM at build time
  const mod = await import('web-tree-sitter')
  _Parser = mod.default ?? mod
  // web-tree-sitter needs its .wasm file — resolve from node_modules at runtime
  const wasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')
  await _Parser.init({ locateFile: () => wasmPath })
  _parserInitialized = true
  return _Parser
}

async function getLanguage(grammarName: string): Promise<any> {
  if (_languageCache.has(grammarName)) return _languageCache.get(grammarName)
  const P = await ensureParser()
  const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`)
  const lang = await P.Language.load(wasmPath)
  _languageCache.set(grammarName, lang)
  return lang
}

export async function parseCode(filePath: string, code: string): Promise<CodeSymbolUnit[]> {
  const ext = extname(filePath).toLowerCase()
  const grammarName = GRAMMAR_MAP[ext]
  if (!grammarName) return []

  const symbolTypes = new Set(SYMBOL_NODE_TYPES[grammarName] ?? [])
  if (symbolTypes.size === 0) return []

  try {
    const P = await ensureParser()
    const lang = await getLanguage(grammarName)
    const parser = new P()
    parser.setLanguage(lang)
    const tree = parser.parse(code)
    if (!tree) return []
    const symbols = collectSymbols(tree.rootNode, code, grammarName, symbolTypes, 0, [])
    tree.delete()
    parser.delete()
    return symbols
  } catch {
    // Grammar load failure or parse error — fall back to text chunking in the caller
    return []
  }
}
