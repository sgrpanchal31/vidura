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
- scope "file": query names a specific document — use the file list to correct typos, set targetFile to the corrected path
- scope "corpus": summary, overview, or generation covering many or all documents; default to corpus for open-ended questions and summaries
- scope "rag": targeted question searching for specific information within documents

- task "podcast": /podcast command or user explicitly wants a podcast format
- task "overview": user wants a summary or overview
- task "chat": standard question and answer

Output format (JSON only):
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
