// Citation extraction + renumbering for agent answers. Same algorithm as the
// old pipeline (rag.ts), but validated against the run's EvidenceRegistry
// instead of a single retrieval batch: the model may cite [11] from a
// read_file done at step 3, and the UI still shows sequential [1], [2], …
import type { EvidenceChunk } from './types'
import type { EvidenceRegistry } from './evidence'

export function remapCitations(
  rawAnswer: string,
  evidence: EvidenceRegistry
): { answer: string; citations: EvidenceChunk[] } {
  // Pass 1: which [N]s are valid citations, in order of first appearance?
  const remap = new Map<number, number>()
  let next = 1
  rawAnswer.replace(/\[(\d+)\]/g, (_, n) => {
    const num = parseInt(n, 10)
    if (evidence.get(num) !== undefined && !remap.has(num)) remap.set(num, next++)
    return ''
  })

  // Pass 2: rewrite the answer with sequential numbers; leave invalid [N]s as-is.
  const answer = rawAnswer.replace(/\[(\d+)\]/g, (orig, n) => {
    const d = remap.get(parseInt(n, 10))
    return d !== undefined ? `[${d}]` : orig
  })

  const citations = [...remap.entries()]
    .map(([oldNum, newNum]) => ({ sourceNum: newNum, chunk: evidence.get(oldNum)!.chunk }))
    .sort((a, b) => a.sourceNum - b.sourceNum)

  return { answer, citations }
}
