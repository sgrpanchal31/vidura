// Semantic search tool — the same hybrid retrieval the old pipeline used
// (dense + BM25 fused, optional reranker, parent dedupe), wrapped as a tool
// the agent can call mid-loop with its own rewritten queries.
import { retrieve, rerankChunks, dedupeByParent } from '../../rag'
import { formatEvidence } from '../evidence'
import type { AgentTool, ToolResult, AgentContext } from '../types'

// Fewer per-call than the seed's 8: mid-loop searches refine, and each passage
// costs prompt budget the small model has to carry for the rest of the run.
const MAX_NEW_PARENTS = 4
const RETRIEVE_TOP_K = 30
// Shorter than the seed's 1500 — same reason.
const EXCERPT_CHARS = 800

export const searchDocumentsTool: AgentTool = {
  name: 'search_documents',
  description:
    'Search the documents by meaning. Finds passages related to the query even when the wording differs. Use a short, specific query.',
  kind: 'observation',
  parameters: {
    query: { type: 'string' },
  },
  async execute(params, ctx: AgentContext): Promise<ToolResult> {
    const query = String(params.query ?? '')
    const results = await retrieve(query, ctx.folderPath, {
      topK: RETRIEVE_TOP_K,
      sourceFileFilter: ctx.allowedFiles,
    })
    const reranked = await rerankChunks(query, results)
    const parents = dedupeByParent(reranked)

    // Only register passages the model hasn't seen — repeats waste budget.
    const fresh = parents.filter((p) => !ctx.evidence.has(p.parentId)).slice(0, MAX_NEW_PARENTS)
    const { added } = ctx.evidence.add(fresh)

    if (added.length === 0) {
      const msg =
        parents.length > 0
          ? 'No new passages — everything this search found is already in the evidence above.'
          : 'No matches. Try different words, or answer from the evidence you have.'
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
