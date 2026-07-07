// The agent loop. Replaces the old router → ragQuery/ragSummarizeFile chat
// path: retrieval runs once up front (the "seed"), then the model repeatedly
// picks one action — search more, read a file, or answer — until it answers
// or a budget runs out.
//
// Reliability model for small local LLMs (3B–20B):
//   1. Decisions are sampled under a JSON grammar → malformed calls impossible.
//   2. Seeded evidence means simple questions can answer at step 1 (no slower
//      than the old single-pass pipeline).
//   3. Hard budgets (step caps, char caps, duplicate detection) bound how far
//      a weak model can wander before we force an answer.
//
// One harness, two exits: a run ends either by streaming a chat answer, or —
// when the model picks a deliverable tool (or the user was explicit, e.g.
// /podcast) — by switching into research mode to gather material with the same
// tools, then rendering a podcast script / overview from the evidence registry.
import { llamaService } from '../inference'
import {
  retrieve,
  rerankChunks,
  dedupeByParent,
  buildPodcastPrompt,
  buildOverviewPrompt,
  type HistoryMessage,
} from '../rag'
import { podcastLengthLine } from '../podcast-script'
import { getLangfuse } from '../telemetry'
import type { LangfuseParent } from '../generate'
import { EvidenceRegistry, formatEvidenceWithinBudget } from './evidence'
import { remapCitations } from './citations'
import {
  buildAgentSystemPrompt,
  buildFirstTurn,
  buildObservationTurn,
  buildResearchTurn,
  narrationFor,
  ANSWER_INSTRUCTION,
} from './prompts'
import { resolveFile } from './tools/resolve-file'
import type { ToolRegistry } from './registry'
import type { AgentContext, AgentRunResult, AgentStepEvent, AgentStepRecord, ToolResult } from './types'

// Tool-executing decisions after the seed. 4 is deliberate: on local token
// speeds each step costs seconds, and past ~4 searches a small model is
// wandering, not converging. Deliverable runs get more room — a podcast is
// worth a longer research phase, and its total time is dominated by TTS anyway.
const MAX_STEPS = 4
const MAX_STEPS_DELIVERABLE = 6
const SEED_TOP_K = 30
// Without a thought field a decision is just {action, params} — tiny. The
// with-thought cap (96) exists for the eval A/B; headroom in both cases so the
// grammar never gets truncated mid-JSON by the token cap.
const DECISION_MAX_TOKENS = 48
const DECISION_MAX_TOKENS_WITH_THOUGHT = 96
const SEED_EVIDENCE_CHARS = 12_000
const OBSERVATION_CHARS = 3_000
// Rough token estimate (chars/4). Past this we stop offering decisions and
// force the terminal — headroom below the 8192-token context so the final
// answer never triggers a context shift that would evict early evidence.
const TRANSCRIPT_TOKEN_GUARD = 6_800
// How much of a tool result goes into the Langfuse span — enough to see what
// the model saw, without megabyte traces.
const TRACE_TOOL_OUTPUT_CHARS = 2_000

const deliverableKind = (tool: string): 'podcast' | 'overview' => (tool === 'generate_podcast' ? 'podcast' : 'overview')

export type AgentRunOptions = {
  question: string
  folderPath: string
  modelId: string
  history: HistoryMessage[]
  registry: ToolRegistry
  allowedFiles?: string[]
  // All indexed files (already intersected with the user's selection by the
  // caller). Used to resolve the fuzzy file names a model puts in deliverable
  // params against real paths. Optional because the eval runner asks questions
  // only.
  availableFiles?: string[]
  // Skip the tool-choice decision — the user was explicit (e.g. /podcast).
  // The run seeds, then goes straight into research mode for this deliverable.
  preset?: { tool: string; params: Record<string, unknown> }
  // Eval A/B only: put a grammar-capped thought back into each decision to
  // measure whether ReAct-style "reason before acting" changes decision
  // quality. Production runs without it — narration is code-derived.
  withThought?: boolean
  onToken: (token: string) => void
  onStep: (event: AgentStepEvent) => void
  externalTrace?: LangfuseParent | null
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { question, folderPath, modelId, history, registry, allowedFiles, onToken, onStep } = opts
  const withThought = opts.withThought ?? false

  const lf = getLangfuse()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelineSpan: any = null
  if (opts.externalTrace) {
    pipelineSpan = opts.externalTrace.span({ name: 'agent-run', input: { question, preset: opts.preset?.tool } })
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

  // Resolve the fuzzy file names a model (or /podcast parser) put in
  // deliverable params against the real index; unresolvable names drop out and
  // the research turn falls back to "the main documents".
  const resolveDeliverableFiles = (params: Record<string, unknown>): string[] => {
    const requested = Array.isArray(params.files) ? params.files.map(String) : []
    return requested.map((f) => resolveFile(f, opts.availableFiles ?? [])).filter((f): f is string => f !== null)
  }

  // The session (and its AbortController) exists for the whole loop — created
  // before seed retrieval so chat:cancel works during every phase, not just
  // while the LLM is generating.
  const systemPrompt = buildAgentSystemPrompt(registry.renderToolDocs(), history, { withThought })
  const decisionGrammar = await llamaService.createJsonGrammar(registry.buildDecisionSchema({ withThought }))
  // Research mode offers observation tools only: the model can't pick
  // "generate_podcast" while already researching a podcast.
  const researchGrammar = await llamaService.createJsonGrammar(
    registry.buildDecisionSchema({ withThought, kinds: ['observation'] })
  )
  const session = await llamaService.createAgentSession(systemPrompt)
  const assertNotCancelled = (): void => {
    if (session.signal.aborted) throw new Error('cancelled')
  }

  let deliverable: AgentRunResult['deliverable']
  let deliverableFiles: string[] = []
  if (opts.preset) {
    deliverable = { tool: opts.preset.tool, params: opts.preset.params }
    deliverableFiles = resolveDeliverableFiles(opts.preset.params)
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

    const evidenceBlock = formatEvidenceWithinBudget(evidence.all(), SEED_EVIDENCE_CHARS)
    // Preset runs skip the tool-choice decision entirely: first turn already
    // states the research goal alongside the seeded evidence.
    let turnText = opts.preset
      ? `Evidence gathered so far:\n${evidenceBlock || '(none yet)'}\n\n${buildResearchTurn(deliverableKind(opts.preset.tool), deliverableFiles)}`
      : buildFirstTurn(question, evidenceBlock)
    // False whenever turnText holds content the model hasn't seen yet (the
    // step budget or context guard can end the loop before the last tool's
    // results were ever sent) — the terminal prompt must carry it then, or the
    // model can't use evidence the deepest runs worked hardest to gather.
    let turnSent = false
    const seenCalls = new Set<string>()
    let maxStep = (deliverable ? MAX_STEPS_DELIVERABLE : MAX_STEPS) + 1

    for (let step = 2; step <= maxStep; step++) {
      assertNotCancelled()
      transcriptChars += turnText.length
      if (transcriptChars / 4 > TRANSCRIPT_TOKEN_GUARD) break

      onStep({
        type: 'phase',
        label: deliverable
          ? `Gathering material for the ${deliverableKind(deliverable.tool)}`
          : step === 2
            ? 'Understanding the question'
            : 'Reviewing the evidence',
      })
      // A generation (not a plain span) so Langfuse shows model + latency per
      // decision — the observability convention for agent LLM calls.
      const decisionGen = trace?.generation({ name: `decide-${step}`, model: modelId, input: turnText })
      const raw = await session.promptJson(turnText, deliverable ? researchGrammar : decisionGrammar, {
        maxTokens: withThought ? DECISION_MAX_TOKENS_WITH_THOUGHT : DECISION_MAX_TOKENS,
      })
      turnSent = true
      transcriptChars += raw.length
      decisionGen?.update({ output: raw })
      decisionGen?.end()

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
      const narration = narrationFor(tool.name, params)

      // Same call twice = the model is stuck; the terminal beats looping.
      const callKey = `${tool.name}:${JSON.stringify(params)}`
      if (seenCalls.has(callKey)) break
      seenCalls.add(callKey)

      // A deliverable decision doesn't end the run — it changes the goal. The
      // same loop continues in research mode (observation tools only, bigger
      // step budget), then the terminal renders instead of answering.
      if (tool.kind === 'deliverable') {
        deliverable = { tool: tool.name, params }
        deliverableFiles = resolveDeliverableFiles(params)
        maxStep = MAX_STEPS_DELIVERABLE + 1
        const record: AgentStepRecord = {
          step,
          thought: narration,
          tool: tool.name,
          params,
          summary: 'Gathering material next',
          evidenceCount: 0,
          durationMs: 0,
        }
        steps.push(record)
        onStep({ type: 'step_start', step, thought: narration, tool: tool.name, params })
        onStep({ type: 'step_result', ...record })
        turnText = buildResearchTurn(deliverableKind(tool.name), deliverableFiles)
        turnSent = false
        continue
      }

      onStep({ type: 'step_start', step, thought: narration, tool: tool.name, params })
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
      toolSpan?.update({
        output: {
          summary: result.uiSummary,
          evidenceCount: result.evidence.length,
          isError: result.isError ?? false,
          llmText: result.llmText.slice(0, TRACE_TOOL_OUTPUT_CHARS),
        },
      })
      toolSpan?.end()

      const record: AgentStepRecord = {
        step,
        thought: narration,
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

    // ── Terminal A: chat answer — one unconstrained streaming generation ─────
    if (!deliverable) {
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
    }
    assertNotCancelled()
  } finally {
    // Released before the render phase: generateStream and the agent session
    // share the one-generation-at-a-time mutex.
    await session.dispose()
  }

  // ── Terminal B: render the deliverable from the gathered evidence ──────────
  // A fresh context (generateStream), not the loop session: a podcast script
  // runs 1000+ tokens and the research transcript already fills most of the 8k
  // window — rendering there would context-shift and evict early evidence.
  const kind = deliverableKind(deliverable.tool)
  onStep({ type: 'phase', label: kind === 'podcast' ? 'Writing the script' : 'Writing the overview' })
  const parents = evidence.all().map((e) => e.chunk)
  const podcastMode = deliverable.params.mode === 'solo' ? 'solo' : 'duo'
  const renderPrompt =
    kind === 'podcast'
      ? buildPodcastPrompt(parents, podcastMode, podcastLengthLine(question))
      : buildOverviewPrompt(parents)
  const renderGen = trace?.generation({ name: `render-${kind}`, model: modelId, input: renderPrompt })
  const script = await llamaService.generateStream(renderPrompt, question, onToken)
  renderGen?.update({ output: script })
  renderGen?.end()

  trace?.update({ output: { deliverable, stepCount: steps.length, scriptChars: script.length } })
  pipelineSpan?.end()
  if (!opts.externalTrace) lf?.flushAsync().catch(() => {})
  return { answer: script, citations: [], steps, deliverable }
}
