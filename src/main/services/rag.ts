import { embedService } from './embed'
import { vectorStore } from './store'
import type { SearchResult } from './store'
import { llamaService } from './inference'

const RETRIEVE_TOP_K = 8

export type RagResult = {
  answer: string
  citations: SearchResult[]
}

function buildSystemPrompt(chunks: SearchResult[]): string {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${c.text.trim()}`)
    .join('\n\n')

  return `You are a research assistant. Answer questions using ONLY the numbered sources below.
Cite every fact with its source number, like [1] or [2]. Multiple citations like [1][3] are fine.
If the answer cannot be found in the sources, say exactly: "I couldn't find that in the provided sources."
Be concise and direct — no preamble, no "Sure!" or "Great question!".

Sources:
${sources}`
}

function extractCitations(answer: string, chunks: SearchResult[]): SearchResult[] {
  const cited = new Set<number>()
  const pattern = /\[(\d+)\]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(answer)) !== null) {
    const n = parseInt(match[1], 10)
    if (n >= 1 && n <= chunks.length) cited.add(n - 1) // 0-indexed
  }

  return [...cited].map((i) => chunks[i])
}

export async function ragQuery(
  question: string,
  folderPath: string,
  modelId: string,
  onToken: (token: string) => void
): Promise<RagResult> {
  // Ensure stores are available (handles re-open after cold start)
  if (!vectorStore.isOpen()) {
    await vectorStore.open(folderPath)
  }
  if (!embedService.isStarted()) {
    await embedService.start()
  }

  // Ensure model is loaded
  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  // Embed query and retrieve relevant chunks
  const [queryVector] = await embedService.embedBatched([question])
  const chunks = await vectorStore.search(queryVector, RETRIEVE_TOP_K)

  if (chunks.length === 0) {
    return {
      answer: "I couldn't find any relevant sources in this notebook.",
      citations: [],
    }
  }

  const systemPrompt = buildSystemPrompt(chunks)
  const answer = await llamaService.generateStream(systemPrompt, question, onToken)
  const citations = extractCitations(answer, chunks)

  return { answer, citations }
}
