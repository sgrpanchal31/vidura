import { createHash } from 'crypto'
import type { PdfPage } from './ingest/pdf'
import type { MarkdownSection } from './ingest/markdown'
import type { ParsedText } from './ingest/text'

export const CHUNK_CHARS = 2048  // ≈512 tokens
export const OVERLAP_CHARS = 256 // ≈64 tokens
export const PARSER_VERSION = '2' as const  // bump when parse/chunk logic changes to force re-index

export type ChunkConfig = {
  chunkChars?: number
  overlapChars?: number
}

export type Chunk = {
  id: string
  sourceFile: string   // relative path from notebook root
  text: string
  chunkIndex: number
  parserVersion: typeof PARSER_VERSION
  pageNumber?: number
  headingAnchor?: string
  lineNumber?: number
}

function splitText(text: string, cfg?: ChunkConfig): string[] {
  const chunkChars = cfg?.chunkChars ?? CHUNK_CHARS
  const overlapChars = cfg?.overlapChars ?? OVERLAP_CHARS

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

function makeId(sourceFile: string, index: number): string {
  return createHash('sha256').update(`${sourceFile}:${index}`).digest('hex').slice(0, 16)
}

export function chunkPdf(relPath: string, pages: PdfPage[], cfg?: ChunkConfig): Chunk[] {
  const chunks: Chunk[] = []
  let idx = 0
  for (const page of pages) {
    for (const text of splitText(page.text, cfg)) {
      chunks.push({ id: makeId(relPath, idx), sourceFile: relPath, text, chunkIndex: idx++, parserVersion: PARSER_VERSION, pageNumber: page.pageNumber })
    }
  }
  return chunks
}

export function chunkMarkdown(relPath: string, sections: MarkdownSection[], cfg?: ChunkConfig): Chunk[] {
  const chunks: Chunk[] = []
  let idx = 0
  for (const section of sections) {
    for (const text of splitText(section.text, cfg)) {
      chunks.push({ id: makeId(relPath, idx), sourceFile: relPath, text, chunkIndex: idx++, parserVersion: PARSER_VERSION, headingAnchor: section.headingAnchor, lineNumber: section.lineNumber })
    }
  }
  return chunks
}

export function chunkText(relPath: string, parsed: ParsedText, cfg?: ChunkConfig): Chunk[] {
  const chunks: Chunk[] = []
  let idx = 0
  for (const text of splitText(parsed.text, cfg)) {
    chunks.push({ id: makeId(relPath, idx), sourceFile: relPath, text, chunkIndex: idx++, parserVersion: PARSER_VERSION, lineNumber: parsed.lineNumber })
  }
  return chunks
}
