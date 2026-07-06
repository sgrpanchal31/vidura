import { describe, it, expect } from 'vitest'
import { EvidenceRegistry, formatEvidence } from './evidence'
import { remapCitations } from './citations'
import { ToolRegistry } from './registry'
import type { AgentTool } from './types'
import type { SearchResult } from '../store'

// Minimal SearchResult factory — only the fields the agent code touches matter
function chunk(parentId: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: `${parentId}-child`,
    text: 'child text',
    parentText: `parent text for ${parentId}`,
    parentId,
    sourceFile: 'docs/paper.pdf',
    chunkIndex: 0,
    pageNumber: 4,
    headingAnchor: undefined,
    headingPath: 'Results',
    lineNumber: undefined,
    score: 1,
    ...overrides,
  }
}

// ─── EvidenceRegistry ────────────────────────────────────────────────────────
// The registry owns citation numbers for a whole agent run: stable, dense,
// deduped by parentId. Everything the citation UI shows hangs off this.

describe('EvidenceRegistry', () => {
  it('assigns sequential numbers and dedupes by parentId', () => {
    const reg = new EvidenceRegistry()
    const first = reg.add([chunk('a'), chunk('b')])
    expect(first.added.map((e) => e.sourceNum)).toEqual([1, 2])

    // 'b' again (found by a second search) keeps its number; 'c' gets the next
    const second = reg.add([chunk('b'), chunk('c')])
    expect(second.added.map((e) => e.sourceNum)).toEqual([3])
    expect(second.entries.map((e) => e.sourceNum)).toEqual([2, 3])
    expect(reg.count()).toBe(3)
  })

  it('formats evidence in the rag.ts prompt style', () => {
    const reg = new EvidenceRegistry()
    const { added } = reg.add([chunk('a')])
    const text = formatEvidence(added)
    expect(text).toContain('[1] From paper.pdf p.4 § Results:')
    expect(text).toContain('parent text for a')
  })
})

// ─── remapCitations ──────────────────────────────────────────────────────────
// The model may cite any registry number ([7] from a step-3 read_file); the UI
// must always see sequential [1], [2], … in first-appearance order.

describe('remapCitations', () => {
  it('renumbers citations in first-appearance order and drops invalid ones', () => {
    const reg = new EvidenceRegistry()
    reg.add([chunk('a'), chunk('b'), chunk('c')]) // [1] [2] [3]

    const raw = 'The score is 28.4 [3]. Earlier work [1] differs. Bogus [9] stays.'
    const { answer, citations } = remapCitations(raw, reg)

    expect(answer).toBe('The score is 28.4 [1]. Earlier work [2] differs. Bogus [9] stays.')
    expect(citations.map((c) => c.sourceNum)).toEqual([1, 2])
    expect(citations[0].chunk.parentId).toBe('c') // [3] appeared first → becomes [1]
    expect(citations[1].chunk.parentId).toBe('a')
  })

  it('handles answers with no citations', () => {
    const reg = new EvidenceRegistry()
    reg.add([chunk('a')])
    const { answer, citations } = remapCitations('No citations here.', reg)
    expect(answer).toBe('No citations here.')
    expect(citations).toEqual([])
  })
})

// ─── ToolRegistry ────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  const fakeTool: AgentTool = {
    name: 'search_documents',
    description: 'Search things.',
    kind: 'observation',
    parameters: { query: { type: 'string' } },
    execute: async () => ({ llmText: '', evidence: [], uiSummary: '' }),
  }

  it('builds a oneOf decision schema with a thought on every branch plus answer', () => {
    const reg = new ToolRegistry()
    reg.register(fakeTool)
    const schema = reg.buildDecisionSchema() as unknown as {
      oneOf: Array<{ properties: Record<string, unknown> }>
    }
    expect(schema.oneOf).toHaveLength(2) // the tool + the terminal "answer"
    for (const branch of schema.oneOf) {
      expect(Object.keys(branch.properties)[0]).toBe('thought') // reason before acting
      expect(branch.properties.action).toBeDefined()
    }
    expect(schema.oneOf[0].properties.query).toEqual({ type: 'string' })
  })

  it('documents every tool plus answer in the prompt docs', () => {
    const reg = new ToolRegistry()
    reg.register(fakeTool)
    const docs = reg.renderToolDocs()
    expect(docs).toContain('"search_documents" (params: "query"): Search things.')
    expect(docs).toContain('"answer"')
  })
})
