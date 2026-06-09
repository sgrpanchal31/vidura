import { createHash } from 'crypto'
import type { PdfPage } from './ingest/pdf'
import type { MarkdownSection } from './ingest/markdown'
import type { ParsedText } from './ingest/text'

// Char-based size approximation: ~4 chars/token. Avoids pulling a tokenizer into the chunker.
// Child chunk — what gets embedded for search. Small = sharper hits.
export const CHILD_CHARS = 1024 // ≈256 tokens
// Cap on parent text sent to the LLM. Large = more context per citation.
export const PARENT_MAX_CHARS = 6000 // ≈1500 tokens
// Overlap between child windows within a parent.
export const OVERLAP_CHARS = 128 // ≈32 tokens

// Legacy fixed-window sizes, kept for eval A/B comparison via strategy:'fixed'.
export const LEGACY_CHUNK_CHARS = 2048
export const LEGACY_OVERLAP_CHARS = 256

// Bump when parse/chunk logic changes to force a clean re-index on next launch.
export const PARSER_VERSION = '3' as const

export type ChunkConfig = {
  chunkChars?: number // child chunk size (default CHILD_CHARS)
  overlapChars?: number // child overlap (default OVERLAP_CHARS)
  parentMaxChars?: number // cap on parent text shown to LLM (default PARENT_MAX_CHARS)
  // 'parentdoc': embed small child, return large parent for LLM context (default).
  // 'fixed': legacy 2048-char sliding window; child == parent. Used for eval A/B.
  strategy?: 'fixed' | 'parentdoc'
}

export type Chunk = {
  id: string
  sourceFile: string // relative path from notebook root
  text: string // small child chunk — embedded and searched
  parentText: string // larger parent unit — shown to the LLM for context
  parentId: string // id of the parent unit; multiple children from the same parent share this
  chunkIndex: number
  parserVersion: typeof PARSER_VERSION
  headingPath?: string // breadcrumb: "Chapter > Section" or "class Foo > bar()"
  headingAnchor?: string // raw heading line, kept for backward compat
  pageNumber?: number
  lineNumber?: number
}

// Internal parent unit before child-window splitting
type ParentUnit = {
  parentText: string
  pageNumber?: number
  lineNumber?: number
  headingAnchor?: string
  headingPath?: string
}

// Split text into overlapping windows, breaking on paragraphs → sentences → words.
function splitIntoWindows(text: string, chunkChars: number, overlapChars: number): string[] {
  if (text.length <= chunkChars) return text.trim() ? [text.trim()] : []

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length)

    if (end < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', end)
      const sentBreak = text.lastIndexOf('. ', end)
      const wordBreak = text.lastIndexOf(' ', end)

      if (paraBreak > start + chunkChars / 2) {
        end = paraBreak + 2
      } else if (sentBreak > start + chunkChars / 2) {
        end = sentBreak + 2
      } else if (wordBreak > start) {
        end = wordBreak + 1
      }
    }

    const chunk = text.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    start = end - overlapChars
    if (start <= 0 || end === text.length) break
  }

  return chunks
}

function makeId(key: string, index: number): string {
  return createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 16)
}

// Shared helper: splits parent units into child-windowed Chunks.
//
// 'parentdoc' mode (default): embed a small child chunk (sharp search hits), but carry
// the full parent text so the LLM gets surrounding context rather than a fragment.
//
// 'fixed' mode: legacy 2048-char sliding window; child == parent. Used by eval A/B
// baseline so the old and new strategies can be compared against the same dataset.
function chunkUnits(relPath: string, units: ParentUnit[], cfg?: ChunkConfig): Chunk[] {
  const strategy = cfg?.strategy ?? 'parentdoc'

  if (strategy === 'fixed') {
    const chunkChars = cfg?.chunkChars ?? LEGACY_CHUNK_CHARS
    const overlapChars = cfg?.overlapChars ?? LEGACY_OVERLAP_CHARS
    const chunks: Chunk[] = []
    let idx = 0
    for (const unit of units) {
      for (const window of splitIntoWindows(unit.parentText, chunkChars, overlapChars)) {
        const id = makeId(relPath, idx)
        chunks.push({
          id,
          sourceFile: relPath,
          text: window,
          parentText: window, // same as text in fixed mode
          parentId: id,
          chunkIndex: idx++,
          parserVersion: PARSER_VERSION,
          headingPath: unit.headingPath,
          headingAnchor: unit.headingAnchor,
          pageNumber: unit.pageNumber,
          lineNumber: unit.lineNumber,
        })
      }
    }
    return chunks
  }

  // Parent-doc mode
  const childChars = cfg?.chunkChars ?? CHILD_CHARS
  const overlapChars = cfg?.overlapChars ?? OVERLAP_CHARS
  const parentMaxChars = cfg?.parentMaxChars ?? PARENT_MAX_CHARS

  const chunks: Chunk[] = []
  let chunkIdx = 0
  let parentIdx = 0

  for (const unit of units) {
    const clampedParent = unit.parentText.slice(0, parentMaxChars)
    const parentId = makeId(relPath + ':p', parentIdx++)
    const children = splitIntoWindows(unit.parentText, childChars, overlapChars)

    if (children.length === 0) continue

    for (const child of children) {
      chunks.push({
        id: makeId(relPath, chunkIdx),
        sourceFile: relPath,
        text: child,
        parentText: clampedParent,
        parentId,
        chunkIndex: chunkIdx++,
        parserVersion: PARSER_VERSION,
        headingPath: unit.headingPath,
        headingAnchor: unit.headingAnchor,
        pageNumber: unit.pageNumber,
        lineNumber: unit.lineNumber,
      })
    }
  }

  return chunks
}

export function chunkPdf(relPath: string, pages: PdfPage[], cfg?: ChunkConfig): Chunk[] {
  const units: ParentUnit[] = pages.map((page) => ({
    parentText: page.text,
    pageNumber: page.pageNumber,
  }))
  return chunkUnits(relPath, units, cfg)
}

export function chunkMarkdown(relPath: string, sections: MarkdownSection[], cfg?: ChunkConfig): Chunk[] {
  const units: ParentUnit[] = sections.map((section) => ({
    // section.text already has the heading prepended (done in parseMarkdown)
    parentText: section.text,
    headingAnchor: section.headingAnchor,
    headingPath: section.headingPath,
    lineNumber: section.lineNumber,
  }))
  return chunkUnits(relPath, units, cfg)
}

export function chunkText(relPath: string, parsed: ParsedText, cfg?: ChunkConfig): Chunk[] {
  const strategy = cfg?.strategy ?? 'parentdoc'

  if (strategy === 'fixed') {
    const units: ParentUnit[] = [{ parentText: parsed.text, lineNumber: parsed.lineNumber }]
    return chunkUnits(relPath, units, cfg)
  }

  // Parent-doc mode: manufacture ~3000-char parent windows from flat text, then
  // child windows within each parent — no natural sections to use as units.
  const PARENT_WINDOW = 3000
  const PARENT_OVERLAP = 512
  const parentWindows = splitIntoWindows(parsed.text, PARENT_WINDOW, PARENT_OVERLAP)
  const units: ParentUnit[] = parentWindows.map((pw) => ({
    parentText: pw,
    lineNumber: parsed.lineNumber,
  }))
  return chunkUnits(relPath, units, cfg)
}

export type CodeSymbolUnit = {
  parentText: string // full symbol text (function/class body)
  symbolPath: string // breadcrumb: e.g. "class Foo > bar()" or "function myFunc"
  startLine: number
}

// Code files: each parsed symbol (function/class/method) is a parent unit.
// Oversized symbols get child windows; small ones become a single chunk.
export function chunkCode(relPath: string, symbols: CodeSymbolUnit[], cfg?: ChunkConfig): Chunk[] {
  if (symbols.length === 0) return []
  const units: ParentUnit[] = symbols.map((s) => ({
    parentText: s.parentText,
    headingPath: s.symbolPath,
    lineNumber: s.startLine,
  }))
  return chunkUnits(relPath, units, cfg)
}
