import { embedService } from './embed'
import { vectorStore } from './store'
import type { SearchResult } from './store'
import { llamaService } from './inference'

const RETRIEVE_TOP_K = 5

// Each retrieved chunk may be up to 2048 chars (~512 tokens). We truncate to
// ~800 chars (~200 tokens) in the prompt so 5 sources ≈ 1000 tokens input,
// leaving ~3000 tokens of the 4096-token context free for the model's response.
const CHUNK_PROMPT_CHARS = 800

export type CitationEntry = {
  sourceNum: number    // the [N] number the model used in the answer
  chunk: SearchResult
}

export type RagResult = {
  answer: string
  citations: CitationEntry[]
}

function buildSystemPrompt(chunks: SearchResult[]): string {
  const sources = chunks
    .map((c, i) => {
      const filename = c.sourceFile.split('/').pop() ?? c.sourceFile
      const loc = c.pageNumber ? ` p.${c.pageNumber}` : c.lineNumber ? ` L${c.lineNumber}` : ''
      const text = c.text.trim().slice(0, CHUNK_PROMPT_CHARS)
      const ellipsis = c.text.trim().length > CHUNK_PROMPT_CHARS ? '…' : ''
      return `[${i + 1}] From ${filename}${loc}:\n${text}${ellipsis}`
    })
    .join('\n\n')

  return `You are a research assistant. Use the document excerpts below to answer the question.
Cite every fact with its source number like [1] or [2].
For broad questions, synthesize what you can from the available excerpts — do not refuse just because the excerpts are partial.
Only say "I couldn't find that in the provided sources." if truly nothing in the excerpts is relevant.
Write complete sentences. No preamble, no "Sure!".

${sources}`
}

function extractCitations(answer: string, chunks: SearchResult[]): CitationEntry[] {
  const seen = new Map<number, CitationEntry>()  // sourceNum → entry (preserves order)
  const pattern = /\[(\d+)\]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(answer)) !== null) {
    const sourceNum = parseInt(match[1], 10)
    if (sourceNum >= 1 && sourceNum <= chunks.length && !seen.has(sourceNum)) {
      seen.set(sourceNum, { sourceNum, chunk: chunks[sourceNum - 1] })
    }
  }

  return [...seen.values()]
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
