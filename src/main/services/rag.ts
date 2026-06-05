import { embedService } from './embed'
import { vectorStore } from './store'
import type { SearchResult } from './store'
import { llamaService } from './inference'
import { DEFAULT_EMBED, embedDim } from './embed-models'

const RETRIEVE_TOP_K = 5

// Qwen3-Embedding is an asymmetric retrieval model: queries must be prefixed with
// a task instruction, while document chunks are embedded as-is.
function formatQueryForEmbed(question: string): string {
  return `Instruct: Given a question, retrieve passages from the user's documents that answer it\nQuery: ${question}`
}

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
      const heading = c.headingAnchor ? ` § ${c.headingAnchor.replace(/^#+\s*/, '')}` : ''
      const text = c.text.trim().slice(0, CHUNK_PROMPT_CHARS)
      const ellipsis = c.text.trim().length > CHUNK_PROMPT_CHARS ? '…' : ''
      return `[${i + 1}] From ${filename}${loc}${heading}:\n${text}${ellipsis}`
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

export type RetrievalConfig = {
  topK: number
}

export async function retrieve(
  question: string,
  folderPath: string,
  cfg: RetrievalConfig
): Promise<SearchResult[]> {
  const embedModel = DEFAULT_EMBED
  const dim = embedDim(embedModel)
  await vectorStore.open(folderPath, { dim })
  await embedService.start(undefined, { modelId: embedModel })
  const [queryVector] = await embedService.embedBatched([formatQueryForEmbed(question)])
  return vectorStore.search(queryVector, cfg.topK)
}

export async function ragQuery(
  question: string,
  folderPath: string,
  modelId: string,
  onToken: (token: string) => void
): Promise<RagResult> {
  // Ensure model is loaded
  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  // Embed query and retrieve relevant chunks
  const chunks = await retrieve(question, folderPath, { topK: RETRIEVE_TOP_K })

  if (chunks.length === 0) {
    return {
      answer: "I couldn't find any relevant sources in this notebook.",
      citations: [],
    }
  }

  const systemPrompt = buildSystemPrompt(chunks)
  const rawAnswer = await llamaService.generateStream(systemPrompt, question, onToken)
  const rawCitations = extractCitations(rawAnswer, chunks)

  // Remap [4] → [1] etc. so the UI always shows sequential citation numbers
  // starting from 1 regardless of which retrieval slot the model happened to cite.
  const remap = new Map<number, number>()
  let next = 1
  rawAnswer.replace(/\[(\d+)\]/g, (_, n) => {
    const num = parseInt(n, 10)
    if (rawCitations.some(c => c.sourceNum === num) && !remap.has(num)) remap.set(num, next++)
    return ''
  })
  const answer = rawAnswer.replace(/\[(\d+)\]/g, (orig, n) => {
    const d = remap.get(parseInt(n, 10))
    return d !== undefined ? `[${d}]` : orig
  })
  const citations = rawCitations
    .filter(c => remap.has(c.sourceNum))
    .map(c => ({ ...c, sourceNum: remap.get(c.sourceNum)! }))
    .sort((a, b) => a.sourceNum - b.sourceNum)

  return { answer, citations }
}
