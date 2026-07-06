// Shared shapes for the agent loop. The agent replaces the old router+pipeline:
// instead of classifying a query and dispatching to a hardcoded flow, the model
// runs a short loop where it picks one tool per step, sees the result, and
// decides again — until it chooses to answer.
import type { GbnfJsonSchema } from 'node-llama-cpp'
import type { SearchResult } from '../store'
import type { EvidenceRegistry } from './evidence'

// One retrieved passage the model has seen, with the stable [N] number it was
// shown under. Same shape as rag.ts's CitationEntry so the renderer's citation
// UI works unchanged.
export type EvidenceChunk = {
  sourceNum: number
  chunk: SearchResult
}

export type ToolResult = {
  // What the model reads next turn. Evidence passages inside MUST be labeled
  // with their registry [N] numbers so the final answer can cite them.
  llmText: string
  // Chunks newly registered by this call (empty for tools like list_files).
  evidence: EvidenceChunk[]
  // One-liner for the step UI, e.g. "Found 4 passages in 2 files".
  uiSummary: string
  // Semantic failure (bad file name, no hits). Fed back to the model as an
  // observation so it can recover — not thrown.
  isError?: boolean
}

export type AgentContext = {
  folderPath: string
  // Files the user selected in the UI; undefined = all files. Every tool must
  // respect this filter.
  allowedFiles?: string[]
  evidence: EvidenceRegistry
}

export interface AgentTool {
  // Also the MCP tool name if we expose tools over MCP later.
  name: string
  // Shown to the model in the system prompt (and later as the MCP description).
  description: string
  // Param name → grammar schema. NOTE: grammar-constrained generation makes
  // every declared property required (GBNF cannot express optional keys), so
  // "optional" params must be required with a neutral default the prompt
  // documents (e.g. start_chunk: 0 = beginning).
  parameters: Readonly<Record<string, GbnfJsonSchema>>
  // observation: result feeds back into the loop for the next decision.
  // deliverable: dispatches a workflow (podcast/overview) and ends the loop.
  kind: 'observation' | 'deliverable'
  // Reserved for future tools with side effects (e.g. write_file) and for the
  // MCP permission gate: the loop must pause for user confirmation before
  // executing. No current tool sets it.
  requiresApproval?: boolean
  execute(params: Record<string, unknown>, ctx: AgentContext, signal: AbortSignal): Promise<ToolResult>
}

// One executed step, persisted with the message so the trace survives reloads.
export type AgentStepRecord = {
  step: number
  thought: string
  tool: string
  params: Record<string, unknown>
  summary: string
  evidenceCount: number
  durationMs: number
  isError?: boolean
}

// Streamed to the renderer while the run is live (chat:step channel).
export type AgentStepEvent =
  | { type: 'step_start'; step: number; thought: string; tool: string; params: Record<string, unknown> }
  | {
      type: 'step_result'
      step: number
      tool: string
      summary: string
      evidenceCount: number
      durationMs: number
      isError?: boolean
    }
  | { type: 'answer_start' }

export type AgentRunResult = {
  answer: string
  citations: EvidenceChunk[]
  steps: AgentStepRecord[]
  // Set when the loop ended by picking a deliverable tool instead of answering.
  // The caller (chat:ask) runs the workflow — the loop itself never does,
  // because the LLM session must be released first (one generation at a time).
  deliverable?: { tool: string; params: Record<string, unknown> }
}
