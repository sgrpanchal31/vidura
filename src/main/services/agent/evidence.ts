// EvidenceRegistry: the single source of truth for citation numbers during an
// agent run. Every passage the model ever sees gets one stable [N] for the
// whole run — the seed retrieval registers [1..8], a later read_file might add
// [9..11]. Deduped by parentId so a chunk found twice keeps its first number
// (otherwise the model could cite the same passage under two numbers).
import type { SearchResult } from '../store'
import type { EvidenceChunk } from './types'

// Same per-passage budget as rag.ts PARENT_PROMPT_CHARS.
const PER_CHUNK_CHARS = 1500

export class EvidenceRegistry {
  private byParentId = new Map<string, EvidenceChunk>()
  private ordered: EvidenceChunk[] = []

  // Registers chunks, assigning the next [N] to ones not seen before.
  // Returns { entries: all requested chunks with their stable numbers,
  //           added: just the newly registered ones }.
  add(chunks: SearchResult[]): { entries: EvidenceChunk[]; added: EvidenceChunk[] } {
    const entries: EvidenceChunk[] = []
    const added: EvidenceChunk[] = []
    for (const chunk of chunks) {
      let entry = this.byParentId.get(chunk.parentId)
      if (!entry) {
        entry = { sourceNum: this.ordered.length + 1, chunk }
        this.byParentId.set(chunk.parentId, entry)
        this.ordered.push(entry)
        added.push(entry)
      }
      entries.push(entry)
    }
    return { entries, added }
  }

  has(parentId: string): boolean {
    return this.byParentId.has(parentId)
  }

  get(sourceNum: number): EvidenceChunk | undefined {
    return this.ordered[sourceNum - 1]
  }

  all(): EvidenceChunk[] {
    return [...this.ordered]
  }

  count(): number {
    return this.ordered.length
  }
}

// Renders evidence in the exact format the old pipeline used (rag.ts
// buildSystemPrompt), so the model's citing habits carry over unchanged:
//   [3] From paper.pdf p.4 § Results:
//   <passage text>…
export function formatEvidence(entries: EvidenceChunk[], perChunkChars = PER_CHUNK_CHARS): string {
  return entries
    .map(({ sourceNum, chunk: c }) => {
      const filename = c.sourceFile.split('/').pop() ?? c.sourceFile
      const loc = c.pageNumber ? ` p.${c.pageNumber}` : c.lineNumber ? ` L${c.lineNumber}` : ''
      const heading = c.headingPath
        ? ` § ${c.headingPath}`
        : c.headingAnchor
          ? ` § ${c.headingAnchor.replace(/^#+\s*/, '')}`
          : ''
      const text = c.parentText.trim().slice(0, perChunkChars)
      const ellipsis = c.parentText.trim().length > perChunkChars ? '…' : ''
      return `[${sourceNum}] From ${filename}${loc}${heading}:\n${text}${ellipsis}`
    })
    .join('\n\n')
}

// Renders as much evidence as fits in charBudget, newest first dropped.
// Numbering stays stable because numbers live on the entries themselves.
export function formatEvidenceWithinBudget(entries: EvidenceChunk[], charBudget: number): string {
  const parts: string[] = []
  let used = 0
  for (const entry of entries) {
    const rendered = formatEvidence([entry])
    if (used + rendered.length > charBudget && parts.length > 0) break
    parts.push(rendered)
    used += rendered.length + 2
  }
  return parts.join('\n\n')
}
