// All prompt text for the agent loop, in one place so tuning is easy.
import type { HistoryMessage } from '../rag'
import { THOUGHT_MAX_CHARS } from './registry'

export function buildAgentSystemPrompt(
  toolDocs: string,
  history: HistoryMessage[],
  opts: { withThought?: boolean } = {}
): string {
  // Same history policy as the old pipeline: last 6 messages, 300 chars each.
  const recentHistory = history.slice(-6)
  const historySection =
    recentHistory.length > 0
      ? '\n\nRecent conversation:\n' +
        recentHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`).join('\n')
      : ''
  // Only mentioned when the grammar actually has the field (eval A/B) —
  // unstated caps cause hallucinations, and unused docs cause confusion.
  const thoughtLine = opts.withThought
    ? `\n"thought" is one short sentence (under ${THOUGHT_MAX_CHARS} characters) explaining your choice.`
    : ''

  return `You are a research assistant that answers questions about the user's documents.
You work in steps. At each step, output ONE JSON object choosing your next action, and nothing else.${thoughtLine}

Actions:
${toolDocs}

Evidence passages are numbered [1], [2], and so on. Most questions are answerable from the evidence already gathered: choose "answer" unless something essential is clearly missing. Every extra search costs the user real time.${historySection}`
}

export function buildFirstTurn(question: string, evidenceBlock: string): string {
  // The explicit "answer now" invitation matters: without it, small models
  // almost never answer at the first decision (eval: 1 of 30 runs), adding a
  // ~12s verification search to nearly every question.
  return `Question: ${question}

Evidence gathered so far:
${evidenceBlock || '(none — the initial search found nothing)'}

If the evidence above covers the question, choose "answer" now. Output your next action as JSON.`
}

export function buildObservationTurn(toolName: string, llmText: string): string {
  return `Result of ${toolName}:
${llmText}

Output your next action as JSON. If the evidence now covers the question, choose "answer".`
}

// The step narration shown in the UI, composed from the structured action.
// Derived, not model-generated: a 4B model's capped thought is noise that
// costs 3-6s of generation per step; the harness already knows what it's doing.
export function narrationFor(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'search_documents':
      return `Searching the documents for "${String(params.query ?? '')}"`
    case 'keyword_search':
      return `Scanning the documents for "${String(params.term ?? '')}"`
    case 'list_files':
      return 'Scanning the file list'
    case 'read_file':
      return `Reading ${String(params.file ?? '')}`
    case 'generate_podcast':
      return 'Preparing a podcast'
    case 'generate_overview':
      return 'Preparing an overview'
    default:
      return `Running ${tool}`
  }
}

// Sent when the run switches into deliverable research: same loop, same tools,
// but the goal is now gathering material for a podcast/overview instead of
// answering a question. "answer" becomes "done researching, render now".
export function buildResearchTurn(kind: 'podcast' | 'overview', files: string[]): string {
  const scope = files.length > 0 ? `Focus on these files: ${files.join(', ')}.` : 'Cover the main documents.'
  const what = kind === 'podcast' ? 'a podcast episode' : 'a written overview'
  return `The user wants ${what} created from their documents. ${scope}
Gather the material first: read the key files or search for their main topics. The evidence gathered so far counts.
When the evidence covers the main points worth including, choose "answer" to start writing. Output your next action as JSON.`
}

// Sent instead of a decision prompt when budgets run out or the model repeats
// itself — no decision is requested, the loop goes straight to the answer.
// The answer instruction carries the citation rules verbatim from the old
// pipeline (rag.ts buildSystemPrompt) so answer style and citing behavior
// carry over unchanged.
export const ANSWER_INSTRUCTION = `Now write the final answer to the question using the evidence above.
Answer the question directly in the first sentence, citing sources like [1] or [2]. Then add only the supporting details that matter.
If the evidence doesn't directly answer the question, state the closest relevant facts it does contain — do not say you cannot find information.
Be concise. No preamble.`
