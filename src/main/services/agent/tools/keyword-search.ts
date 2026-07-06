// Exact-term search (BM25 full-text) — the "grep" next to search_documents'
// semantic search. Finds literal strings, numbers, and names that embedding
// similarity misses (e.g. "28.4 BLEU", "useEffect", "Vaswani").
import { vectorStore } from '../../store'
import { DEFAULT_EMBED, embedDim } from '../../embed-models'
import { dedupeByParent } from '../../rag'
import { formatEvidence } from '../evidence'
import type { AgentTool, ToolResult, AgentContext } from '../types'

const FTS_TOP_K = 20
const MAX_NEW_PARENTS = 4
const EXCERPT_CHARS = 800

export const keywordSearchTool: AgentTool = {
  name: 'keyword_search',
  description:
    'Search the documents for an exact word or phrase (names, numbers, code identifiers). Use when search_documents missed a specific term.',
  kind: 'observation',
  parameters: {
    term: { type: 'string' },
  },
  async execute(params, ctx: AgentContext): Promise<ToolResult> {
    const term = String(params.term ?? '')
    await vectorStore.open(ctx.folderPath, { dim: embedDim(DEFAULT_EMBED) })
    const results = await vectorStore.searchFts(term, FTS_TOP_K, ctx.allowedFiles)
    const parents = dedupeByParent(results)

    const fresh = parents.filter((p) => !ctx.evidence.has(p.parentId)).slice(0, MAX_NEW_PARENTS)
    const { added } = ctx.evidence.add(fresh)

    if (added.length === 0) {
      const msg =
        parents.length > 0
          ? 'No new passages — the matches are already in the evidence above.'
          : `No documents contain "${term}". Try a different term, or answer from the evidence you have.`
      return { llmText: msg, evidence: [], uiSummary: 'No new passages', isError: parents.length === 0 }
    }

    const files = new Set(added.map((e) => e.chunk.sourceFile))
    return {
      llmText: formatEvidence(added, EXCERPT_CHARS),
      evidence: added,
      uiSummary: `Found ${added.length} passage${added.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'}`,
    }
  },
}
