import { describe, it, expect } from 'vitest'
import { chunkText, chunkMarkdown, chunkCode, PARSER_VERSION } from './chunker'
import type { MarkdownSection } from './ingest/markdown'

// ─── chunkText ───────────────────────────────────────────────────────────────
// chunkText is the most-used path: flat .txt files with no section structure.
// It manufactures ~3000-char parent windows internally, then cuts small child
// windows inside each parent for embedding.

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('notes.txt', { text: 'Hello world', lineNumber: 1 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('Hello world')
    expect(chunks[0].sourceFile).toBe('notes.txt')
    expect(chunks[0].parserVersion).toBe(PARSER_VERSION)
  })

  it('splits long text into more than one chunk', () => {
    // ~3 500 chars — forces at least one parent-window split
    const longText = 'word '.repeat(700)
    const chunks = chunkText('long.txt', { text: longText, lineNumber: 1 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('all chunks from one parent window share the same parentId', () => {
    // ~2 000 chars — fits in a single 3 000-char parent window but spawns many
    // small child windows when chunkChars is reduced.
    const text = 'sentence here. '.repeat(130)
    const chunks = chunkText('doc.txt', { text, lineNumber: 1 }, { chunkChars: 128, overlapChars: 16 })
    const parentIds = new Set(chunks.map((c) => c.parentId))
    expect(parentIds.size).toBe(1)
  })

  it('fixed strategy: child text equals parent text', () => {
    // In fixed mode (legacy sliding window) there is no parent-doc split;
    // both fields carry the same window so the LLM gets the same text we searched.
    const chunks = chunkText('notes.txt', { text: 'Short text here', lineNumber: 1 }, { strategy: 'fixed' })
    expect(chunks.length).toBeGreaterThan(0)
    chunks.forEach((c) => expect(c.text).toBe(c.parentText))
  })
})

// ─── chunkMarkdown ───────────────────────────────────────────────────────────
// Markdown files are pre-split into sections by parseMarkdown; chunkMarkdown
// wraps each section as a parent unit.

describe('chunkMarkdown', () => {
  it('produces one chunk per section for short sections', () => {
    const sections: MarkdownSection[] = [
      { headingAnchor: '# Intro', headingPath: 'Intro', text: '# Intro\n\nSome text here.', lineNumber: 1 },
      { headingAnchor: '# Setup', headingPath: 'Setup', text: '# Setup\n\nInstall it.', lineNumber: 5 },
    ]
    const chunks = chunkMarkdown('doc.md', sections)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].headingPath).toBe('Intro')
    expect(chunks[1].headingPath).toBe('Setup')
  })

  it('carries headingAnchor and sourceFile from section', () => {
    const sections: MarkdownSection[] = [
      {
        headingAnchor: '## Config',
        headingPath: 'Guide > Config',
        text: '## Config\n\nSome config text.',
        lineNumber: 3,
      },
    ]
    const chunks = chunkMarkdown('guide.md', sections)
    expect(chunks[0].headingAnchor).toBe('## Config')
    expect(chunks[0].sourceFile).toBe('guide.md')
  })
})

// ─── chunkCode ───────────────────────────────────────────────────────────────
// Code files are parsed into symbols (functions, classes) upstream; chunkCode
// turns each symbol into a parent unit.

describe('chunkCode', () => {
  it('returns an empty array when no symbols are provided', () => {
    expect(chunkCode('empty.ts', [])).toEqual([])
  })

  it('produces at least one chunk per symbol, with symbolPath as headingPath', () => {
    const symbols = [
      { parentText: 'function foo() { return 1 }', symbolPath: 'function foo', startLine: 1 },
      { parentText: 'function bar() { return 2 }', symbolPath: 'function bar', startLine: 5 },
    ]
    const chunks = chunkCode('foo.ts', symbols)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Chunks are ordered by symbol order
    expect(chunks[0].headingPath).toBe('function foo')
    expect(chunks[1].headingPath).toBe('function bar')
  })
})
