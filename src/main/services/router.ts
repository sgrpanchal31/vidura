import { llamaService } from './inference'

export type RoutingDecision = {
  scope: 'rag' | 'corpus' | 'file'
  task: 'chat' | 'podcast' | 'overview'
  targetFile: string | null
}

// Minimal structural type matching what we actually call on a Langfuse trace object
type TraceClient = {
  span(opts: { name: string; input?: unknown }): {
    update(o: { output?: unknown }): void
    end(): void
  }
}

const SYSTEM_PROMPT = `You are a query router for a document chat app. Output ONLY a JSON object, no explanation, no markdown.

Rules:
- scope "file": a word or phrase in the query names a specific document — match case-insensitively, ignore extension (e.g. "CLAUDE" matches "CLAUDE.md"); set targetFile to the EXACT relative path from the file list
- scope "corpus": ONLY when the user explicitly asks to synthesize or summarize ALL or MOST documents (e.g. "give me an overview of everything", "summarize all my notes", "/podcast"); always pairs with task "overview" or "podcast", NEVER with task "chat"
- scope "rag": DEFAULT for all Q&A and factual questions, even when no specific file is named; use whenever the user is asking a question rather than requesting broad synthesis across all documents

- task "podcast": /podcast command or user explicitly wants a podcast
- task "overview": user wants a summary or overview
- task "chat": standard question and answer

Examples:
Query: "summarize CLAUDE"
Available files: CLAUDE.md, notes.md
Output: {"scope":"file","task":"overview","targetFile":"CLAUDE.md"}

Query: "what is the person currently doing"
Available files: about/bio.md, about/working-style.md
Output: {"scope":"rag","task":"chat","targetFile":null}

Query: "give me an overview of all my notes"
Available files: notes.md, journal.md
Output: {"scope":"corpus","task":"overview","targetFile":null}

Output format (JSON only, no extra text):
{"scope":"...","task":"...","targetFile":null}`

export async function routeQuery(
  question: string,
  availableFiles: string[],
  trace?: TraceClient | null
): Promise<RoutingDecision> {
  const routeSpan = trace?.span({ name: 'route', input: { question } })

  const fileLines = availableFiles
    .slice(0, 100)
    .map((f) => `- ${f}`)
    .join('\n')
  const userPrompt =
    availableFiles.length > 0 ? `Query: ${question}\n\nAvailable files:\n${fileLines}` : `Query: ${question}`

  try {
    const raw = await llamaService.generateStream(SYSTEM_PROMPT, userPrompt, () => {}, { maxTokens: 80 })
    const match = raw.match(/\{[^}]+\}/)
    if (!match) throw new Error('no JSON in response')
    const d = JSON.parse(match[0]) as RoutingDecision
    if (!['rag', 'corpus', 'file'].includes(d.scope)) throw new Error(`invalid scope: ${d.scope}`)
    if (!['chat', 'podcast', 'overview'].includes(d.task)) throw new Error(`invalid task: ${d.task}`)
    routeSpan?.update({ output: { ...d, usedFallback: false } })
    routeSpan?.end()
    return d
  } catch {
    const d = fallbackRoute(question)
    routeSpan?.update({ output: { ...d, usedFallback: true } })
    routeSpan?.end()
    return d
  }
}

function fallbackRoute(question: string): RoutingDecision {
  const q = question.trimStart()
  if (q.startsWith('/podcast')) return { scope: 'corpus', task: 'podcast', targetFile: null }
  if (/\b(summarize|summarise|summary|overview)\b/i.test(q))
    return { scope: 'corpus', task: 'overview', targetFile: null }
  return { scope: 'rag', task: 'chat', targetFile: null }
}
