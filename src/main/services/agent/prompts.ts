// All prompt text for the agent loop, in one place so tuning is easy.
import type { HistoryMessage } from '../rag'
import { THOUGHT_MAX_CHARS } from './registry'

export function buildAgentSystemPrompt(toolDocs: string, history: HistoryMessage[]): string {
  // Same history policy as the old pipeline: last 6 messages, 300 chars each.
  const recentHistory = history.slice(-6)
  const historySection =
    recentHistory.length > 0
      ? '\n\nRecent conversation:\n' +
        recentHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`).join('\n')
      : ''

  return `You are a research assistant that answers questions about the user's documents.
You work in steps. At each step, output ONE JSON object choosing your next action, and nothing else.
"thought" is one short sentence (under ${THOUGHT_MAX_CHARS} characters) explaining your choice.

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

// Sent instead of a decision prompt when budgets run out or the model repeats
// itself — no decision is requested, the loop goes straight to the answer.
// The answer instruction carries the citation rules verbatim from the old
// pipeline (rag.ts buildSystemPrompt) so answer style and citing behavior
// carry over unchanged.
export const ANSWER_INSTRUCTION = `Now write the final answer to the question using the evidence above.
Answer the question directly in the first sentence, citing sources like [1] or [2]. Then add only the supporting details that matter.
If the evidence doesn't directly answer the question, state the closest relevant facts it does contain — do not say you cannot find information.
Be concise. No preamble.`
