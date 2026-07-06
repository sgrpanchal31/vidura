// The agent loop. Replaces the old router → ragQuery/ragSummarizeFile chat
// path: retrieval runs once up front (the "seed"), then the model repeatedly
// picks one action — search more, read a file, or answer — until it answers
// or a budget runs out.
//
// Reliability model for small local LLMs (3B–20B):
//   1. Decisions are sampled under a JSON grammar → malformed calls impossible.
//   2. Seeded evidence means simple questions can answer at step 1 (no slower
//      than the old single-pass pipeline).
//   3. Hard budgets (MAX_STEPS, char caps, duplicate detection) bound how far
//      a weak model can wander before we force an answer.
import { llamaService } from '../inference'
import { retrieve, rerankChunks, dedupeByParent, type HistoryMessage } from '../rag'
import { getLangfuse } from '../telemetry'
import type { LangfuseParent } from '../generate'
import { EvidenceRegistry, formatEvidenceWithinBudget } from './evidence'
import { remapCitations } from './citations'
import { buildAgentSystemPrompt, buildFirstTurn, buildObservationTurn, ANSWER_INSTRUCTION } from './prompts'
import type { ToolRegistry } from './registry'
import type { AgentContext, AgentRunResult, AgentStepEvent, AgentStepRecord, ToolResult } from './types'

// Tool-executing decisions after the seed. 4 is deliberate: on local token
// speeds each step costs seconds, and past ~4 searches a small model is
// wandering, not converging.
const MAX_STEPS = 4
const SEED_TOP_K = 30
// Thought (≤100 chars) + action + params fits comfortably; headroom so the
// grammar never gets truncated mid-JSON by the token cap. Kept tight because
// every decision token costs real time on local hardware (eval: 3-6s/decision).
const DECISION_MAX_TOKENS = 96
const SEED_EVIDENCE_CHARS = 12_000
const OBSERVATION_CHARS = 3_000
// Rough token estimate (chars/4). Past this we stop offering decisions and
// force the answer — headroom below the 8192-token context so the final
// answer never triggers a context shift that would evict early evidence.
const TRANSCRIPT_TOKEN_GUARD = 6_800

export type AgentRunOptions = {
  question: string
  folderPath: string
  modelId: string
  history: HistoryMessage[]
  registry: ToolRegistry
  allowedFiles?: string[]
  onToken: (token: string) => void
  onStep: (event: AgentStepEvent) => void
  externalTrace?: LangfuseParent | null
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { question, folderPath, modelId, history, registry, allowedFiles, onToken, onStep } = opts

  const lf = getLangfuse()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelineSpan: any = null
  if (opts.externalTrace) {
    pipelineSpan = opts.externalTrace.span({ name: 'agent-run', input: { question } })
    trace = pipelineSpan
  } else {
    trace = lf?.trace({ name: 'agent-run', input: question }) ?? null
  }

  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  const evidence = new EvidenceRegistry()
  const ctx: AgentContext = { folderPath, allowedFiles, evidence }
  const steps: AgentStepRecord[] = []

  // The session (and its AbortController) exists for the WHOLE run — created
  // before seed retrieval so chat:cancel works during every phase, not just
  // while the LLM is generating.
  const systemPrompt = buildAgentSystemPrompt(registry.renderToolDocs(), history)
  const decisionGrammar = await llamaService.createJsonGrammar(registry.buildDecisionSchema())
  const session = await llamaService.createAgentSession(systemPrompt)
  const assertNotCancelled = (): void => {
    if (session.signal.aborted) throw new Error('cancelled')
  }

  try {
    // ── Step 1: seeded retrieval ────────────────────────────────────────────
    // The same hybrid search + rerank + parent-dedupe the old pipeline ran.
    // Done in code (not by the model) so every run starts with evidence on the
    // table and easy questions can answer immediately.
    const seedThought = 'Searching the documents for passages related to the question'
    onStep({ type: 'step_start', step: 1, thought: seedThought, tool: 'search_documents', params: { query: question } })
    const seedStart = Date.now()
    const seedSpan = trace?.span({ name: 'seed-retrieve', input: { question } })
    const seedChunks = await retrieve(question, folderPath, { topK: SEED_TOP_K, sourceFileFilter: allowedFiles })
    const seedParents = dedupeByParent(await rerankChunks(question, seedChunks))
    evidence.add(seedParents)
    seedSpan?.update({
      output: seedParents.map((c, i) => ({ rank: i + 1, sourceFile: c.sourceFile, text: c.text.slice(0, 200) })),
    })
    seedSpan?.end()
    const seedFiles = new Set(seedParents.map((c) => c.sourceFile))
    const seedRecord: AgentStepRecord = {
      step: 1,
      thought: seedThought,
      tool: 'search_documents',
      params: { query: question },
      summary:
        seedParents.length > 0
          ? `Found ${seedParents.length} passages in ${seedFiles.size} file${seedFiles.size === 1 ? '' : 's'}`
          : 'No matches',
      evidenceCount: seedParents.length,
      durationMs: Date.now() - seedStart,
    }
    steps.push(seedRecord)
    onStep({ type: 'step_result', ...seedRecord })
    assertNotCancelled()

    // ── The loop ────────────────────────────────────────────────────────────
    // Everything sent to the model, for the context-budget estimate (chars/4).
    let transcriptChars = systemPrompt.length

    let turnText = buildFirstTurn(question, formatEvidenceWithinBudget(evidence.all(), SEED_EVIDENCE_CHARS))
    // False whenever turnText holds content the model hasn't seen yet (the
    // step budget or context guard can end the loop before the last tool's
    // results were ever sent) — the answer prompt must carry it then, or the
    // model can't use evidence the deepest runs worked hardest to gather.
    let turnSent = false
    const seenCalls = new Set<string>()
    let deliverable: AgentRunResult['deliverable']

    for (let step = 2; step <= MAX_STEPS + 1; step++) {
      assertNotCancelled()
      transcriptChars += turnText.length
      if (transcriptChars / 4 > TRANSCRIPT_TOKEN_GUARD) break

      const decisionSpan = trace?.span({ name: `decide-${step}`, input: { turnText: turnText.slice(0, 500) } })
      const raw = await session.promptJson(turnText, decisionGrammar, { maxTokens: DECISION_MAX_TOKENS })
      turnSent = true
      transcriptChars += raw.length
      decisionSpan?.update({ output: raw })
      decisionSpan?.end()

      // The grammar guarantees valid JSON; parse can only fail if the token
      // cap truncated it. Treat that as "answer now" rather than retrying.
      let decision: { thought?: string; action?: string; [key: string]: unknown }
      try {
        decision = JSON.parse(raw)
      } catch {
        break
      }

      if (decision.action === 'answer') break

      const tool = registry.get(String(decision.action))
      if (!tool) break // unreachable via grammar; belt-and-braces

      const { thought: _thought, action: _action, ...params } = decision
      const thought = String(decision.thought ?? '')

      // Same call twice = the model is stuck; answering beats looping.
      const callKey = `${tool.name}:${JSON.stringify(params)}`
      if (seenCalls.has(callKey)) break
      seenCalls.add(callKey)

      // A deliverable tool (podcast/overview) ends the loop: the caller runs
      // the workflow after this session is disposed — one generation at a time.
      if (tool.kind === 'deliverable') {
        deliverable = { tool: tool.name, params }
        const record: AgentStepRecord = {
          step,
          thought,
          tool: tool.name,
          params,
          summary: 'Handing off',
          evidenceCount: 0,
          durationMs: 0,
        }
        steps.push(record)
        onStep({ type: 'step_start', step, thought, tool: tool.name, params })
        onStep({ type: 'step_result', ...record })
        break
      }

      onStep({ type: 'step_start', step, thought, tool: tool.name, params })
      const stepStart = Date.now()
      const toolSpan = trace?.span({ name: `tool-${tool.name}`, input: params })
      let result: ToolResult
      try {
        result = await tool.execute(params, ctx, session.signal)
      } catch (err) {
        if (session.signal.aborted) throw err
        // Tool crash becomes an observation the model can react to.
        result = {
          llmText: `The ${tool.name} call failed: ${String(err).slice(0, 200)}`,
          evidence: [],
          uiSummary: 'Tool failed',
          isError: true,
        }
      }
      toolSpan?.update({ output: { summary: result.uiSummary, isError: result.isError ?? false } })
      toolSpan?.end()

      const record: AgentStepRecord = {
        step,
        thought,
        tool: tool.name,
        params,
        summary: result.uiSummary,
        evidenceCount: result.evidence.length,
        durationMs: Date.now() - stepStart,
        ...(result.isError ? { isError: true } : {}),
      }
      steps.push(record)
      onStep({ type: 'step_result', ...record })

      turnText = buildObservationTurn(tool.name, result.llmText.slice(0, OBSERVATION_CHARS))
      turnSent = false
    }

    if (deliverable) {
      trace?.update({ output: { deliverable } })
      pipelineSpan?.end()
      if (!opts.externalTrace) lf?.flushAsync().catch(() => {})
      return { answer: '', citations: [], steps, deliverable }
    }

    // ── Final answer: one unconstrained streaming generation ─────────────────
    assertNotCancelled()
    onStep({ type: 'answer_start' })
    const answerPrompt = turnSent ? ANSWER_INSTRUCTION : `${turnText}\n\n${ANSWER_INSTRUCTION}`
    const gen = trace?.generation({ name: 'answer', model: modelId, input: answerPrompt })
    const rawAnswer = await session.promptText(answerPrompt, { onToken })
    gen?.update({ output: rawAnswer })
    gen?.end()

    const { answer, citations } = remapCitations(rawAnswer, evidence)
    trace?.update({ output: { answer, stepCount: steps.length } })
    pipelineSpan?.end()
    if (!opts.externalTrace) lf?.flushAsync().catch(() => {})
    return { answer, citations, steps }
  } finally {
    await session.dispose()
  }
}
