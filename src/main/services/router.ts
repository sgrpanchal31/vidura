import { llamaService } from './inference'

export type RoutingDecision = {
  scope: 'rag' | 'corpus' | 'file'
  task: 'chat' | 'podcast' | 'overview'
  targetFiles: string[]
  podcastMode: 'solo' | 'duo' // only meaningful when task is 'podcast'
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
- scope "file": one or more words in the query name specific documents — match case-insensitively, ignore extension (e.g. "CLAUDE" matches "CLAUDE.md"); set targetFiles to an array of EXACT relative paths from the file list; include ALL files mentioned
- scope "corpus": ONLY when the user explicitly asks to synthesize or summarize ALL or MOST documents (e.g. "give me an overview of everything", "summarize all my notes", "/podcast"); always pairs with task "overview" or "podcast", NEVER with task "chat"
- scope "rag": DEFAULT for all Q&A and factual questions, even when no specific file is named; use whenever the user is asking a question rather than requesting broad synthesis

- task "podcast": /podcast command or user explicitly wants a podcast
- task "overview": user wants a summary or overview
- task "chat": standard question and answer

- podcastMode "solo": the user wants a single narrator or one voice (e.g. "I narrate", "single narrator", "one host", "in my voice", "an expert explains this paper", "walk me through this document")
- podcastMode "duo": two hosts discussing; the default whenever the user did not ask for a single voice

Examples:
Query: "summarize CLAUDE"
Available files: CLAUDE.md, notes.md
Output: {"scope":"file","task":"overview","targetFiles":["CLAUDE.md"]}

Query: "summarize life purpose and memory file"
Available files: life-purpose.md, MEMORY.md, notes.md
Output: {"scope":"file","task":"overview","targetFiles":["life-purpose.md","MEMORY.md"]}

Query: "what is the person currently doing"
Available files: about/bio.md, about/working-style.md
Output: {"scope":"rag","task":"chat","targetFiles":[]}

Query: "give me an overview of all my notes"
Available files: notes.md, journal.md
Output: {"scope":"corpus","task":"overview","targetFiles":[]}

Query: "/podcast Create a podcast where I narrate my month based on my journal"
Available files: journal.md, notes.md
Output: {"scope":"corpus","task":"podcast","targetFiles":[],"podcastMode":"solo"}

Output format (JSON only, no extra text):
{"scope":"...","task":"...","targetFiles":[],"podcastMode":"duo"}`

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
    const raw = await llamaService.generateStream(SYSTEM_PROMPT, userPrompt, () => {}, { maxTokens: 200 })
    // Match the first {...} block — targetFiles array doesn't contain }, so this works
    const match = raw.match(/\{[^}]+\}/)
    if (!match) throw new Error('no JSON in response')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(match[0]) as any
    if (!['rag', 'corpus', 'file'].includes(parsed.scope)) throw new Error(`invalid scope: ${parsed.scope}`)
    if (!['chat', 'podcast', 'overview'].includes(parsed.task)) throw new Error(`invalid task: ${parsed.task}`)
    // Normalize: model may output targetFile (old format) or targetFiles (new array format)
    const targetFiles: string[] = Array.isArray(parsed.targetFiles)
      ? parsed.targetFiles
      : parsed.targetFile
        ? [parsed.targetFile]
        : []
    // Lenient: the model may omit podcastMode on non-podcast queries — never fail on it
    const podcastMode = parsed.podcastMode === 'solo' ? 'solo' : 'duo'
    const d: RoutingDecision = { scope: parsed.scope, task: parsed.task, targetFiles, podcastMode }
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
  // Keyword guess for narrator count when the LLM router is unavailable
  const podcastMode = /\bnarrat|\b(solo|single|one)\b.{0,20}\b(narrator|voice|host|person)\b/i.test(q) ? 'solo' : 'duo'
  if (q.startsWith('/podcast')) return { scope: 'corpus', task: 'podcast', targetFiles: [], podcastMode }
  if (/\b(summarize|summarise|summary|overview)\b/i.test(q))
    return { scope: 'corpus', task: 'overview', targetFiles: [], podcastMode }
  return { scope: 'rag', task: 'chat', targetFiles: [], podcastMode }
}
