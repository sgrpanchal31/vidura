import { embedService } from './embed'
import { vectorStore } from './store'
import type { SearchResult } from './store'
import { llamaService } from './inference'
import { DEFAULT_EMBED, embedDim } from './embed-models'
import { getLangfuse } from './telemetry'
import { rerankerGgufService } from './reranker-gguf'
import type { LangfuseParent } from './generate'

// Retrieve more child chunks than we'll show, then collapse to unique parents.
const RETRIEVE_TOP_K = 30
const MAX_UNIQUE_PARENTS = 8

// Qwen3-Embedding is an asymmetric retrieval model: queries must be prefixed with
// a task instruction, while document chunks are embedded as-is.
function formatQueryForEmbed(question: string): string {
  return `Instruct: Given a question, retrieve passages from the user's documents that answer it\nQuery: ${question}`
}

// Parent text can be up to PARENT_MAX_CHARS (~6000 chars). Show up to 1500 chars
// in the prompt; 8 sources × 1500 ≈ 12000 chars ≈ 3000 tokens of source material,
// plus ~700 tokens for history + instruction + question, leaving ~4500 tokens of
// the 8192-token context for the model's response.
const PARENT_PROMPT_CHARS = 1500

export type HistoryMessage = { role: 'user' | 'assistant'; content: string }

export type ChatProgress = { stage: 'reading' } | { stage: 'reranking' } | { stage: 'generating' }

export type CitationEntry = {
  sourceNum: number // the [N] number the model used in the answer
  chunk: SearchResult
}

export type RagResult = {
  answer: string
  citations: CitationEntry[]
}

// Rerank all candidate chunks with the cross-encoder before deduplication.
// Running on the full pool (not just 8 parents) gives the reranker maximum headroom.
// No-op if the reranker isn't ready (disabled or model not loaded).
async function rerankChunks(query: string, chunks: SearchResult[]): Promise<SearchResult[]> {
  if (!rerankerGgufService.isReady() || chunks.length === 0) return chunks
  try {
    const docs = chunks.map((c) => c.parentText.slice(0, 2000))
    const scores = await rerankerGgufService.rerank(query, docs)
    return [...chunks]
      .map((c, i) => ({ ...c, _rerankScore: scores[i] ?? 0 }))
      .sort((a, b) => ((b as any)._rerankScore ?? 0) - ((a as any)._rerankScore ?? 0))
  } catch {
    return chunks
  }
}

// Collapse child chunks to unique parents, keeping the highest-scoring child per parent.
// Chunks arrive ordered best-score-first, so the first occurrence of each parentId is best.
function dedupeByParent(chunks: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>()
  for (const c of chunks) {
    if (!seen.has(c.parentId)) seen.set(c.parentId, c)
  }
  return [...seen.values()].slice(0, MAX_UNIQUE_PARENTS)
}

function buildPodcastPrompt(parents: SearchResult[]): string {
  const passages = parents
    .map((c) => {
      const filename = c.sourceFile.split('/').pop() ?? c.sourceFile
      return `${filename}:\n${c.parentText.trim().slice(0, PARENT_PROMPT_CHARS)}`
    })
    .join('\n\n')
  return `You are creating a podcast script from retrieved document passages.
Combine the key ideas into a natural, engaging narrative as if a host is speaking to an audience.
Do not use citation numbers or mention source filenames. Write in flowing spoken prose.

Passages:
${passages}`
}

function buildOverviewPrompt(parents: SearchResult[]): string {
  const passages = parents
    .map((c) => {
      const filename = c.sourceFile.split('/').pop() ?? c.sourceFile
      return `${filename}:\n${c.parentText.trim().slice(0, PARENT_PROMPT_CHARS)}`
    })
    .join('\n\n')
  return `Write a clear, cohesive overview synthesizing the key ideas from these retrieved passages.
Write in flowing prose. Do not use citation numbers or mention source filenames.

Passages:
${passages}`
}

function buildSystemPrompt(parents: SearchResult[], history: HistoryMessage[]): string {
  const sources = parents
    .map((c, i) => {
      const filename = c.sourceFile.split('/').pop() ?? c.sourceFile
      const loc = c.pageNumber ? ` p.${c.pageNumber}` : c.lineNumber ? ` L${c.lineNumber}` : ''
      // Prefer rich headingPath breadcrumb; fall back to raw headingAnchor
      const heading = c.headingPath
        ? ` § ${c.headingPath}`
        : c.headingAnchor
          ? ` § ${c.headingAnchor.replace(/^#+\s*/, '')}`
          : ''
      const text = c.parentText.trim().slice(0, PARENT_PROMPT_CHARS)
      const ellipsis = c.parentText.trim().length > PARENT_PROMPT_CHARS ? '…' : ''
      return `[${i + 1}] From ${filename}${loc}${heading}:\n${text}${ellipsis}`
    })
    .join('\n\n')

  // Include last 2 turns of history so follow-up questions have context.
  // Each message is truncated to 300 chars to protect the context window.
  const recentHistory = history.slice(-6)
  const historySection =
    recentHistory.length > 0
      ? '\n\nRecent conversation:\n' +
        recentHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`).join('\n')
      : ''

  return `You are a research assistant. Use the excerpts below to help with the question.
Describe what you find in these excerpts that relates to the question. Always cite sources with [1] or [2].
If the excerpts don't directly answer the question, describe the closest relevant content you find.
Write complete sentences. No preamble. Do not say you cannot find information — instead, describe what IS in the excerpts.

${sources}${historySection}`
}

function extractCitations(answer: string, parents: SearchResult[]): CitationEntry[] {
  const seen = new Map<number, CitationEntry>() // sourceNum → entry (preserves order)
  const pattern = /\[(\d+)\]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(answer)) !== null) {
    const sourceNum = parseInt(match[1], 10)
    if (sourceNum >= 1 && sourceNum <= parents.length && !seen.has(sourceNum)) {
      seen.set(sourceNum, { sourceNum, chunk: parents[sourceNum - 1] })
    }
  }

  return [...seen.values()]
}

export type RetrievalConfig = {
  topK: number
  sourceFileFilter?: string[]
}

export async function retrieve(question: string, folderPath: string, cfg: RetrievalConfig): Promise<SearchResult[]> {
  const embedModel = DEFAULT_EMBED
  const dim = embedDim(embedModel)
  await vectorStore.open(folderPath, { dim })
  await embedService.start(undefined, { modelId: embedModel })
  const [queryVector] = await embedService.embedBatched([formatQueryForEmbed(question)])
  // Use raw question for BM25 (keywords), instruction-prefixed vector for dense search
  return vectorStore.searchHybrid(queryVector, question, cfg.topK, cfg.sourceFileFilter)
}

// Ask the LLM to rewrite the user's question into 2-3 short search queries.
// Falls back to [question] on any error so retrieval always proceeds.
async function expandQuery(question: string, history: HistoryMessage[]): Promise<string[]> {
  const recentContext =
    history.length > 0
      ? history
          .slice(-6)
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
          .join('\n') + '\n\n'
      : ''

  const systemPrompt = `You are a search query generator. Given a question (and optional conversation context), output 2-3 short search queries that would find relevant document passages.
Output one query per line. No bullets, no numbers, no punctuation at end. Nothing else.`

  const userPrompt = `${recentContext}Question: ${question}`

  try {
    const raw = await llamaService.generateStream(systemPrompt, userPrompt, () => {}, { maxTokens: 120 })
    const queries = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && l.length < 200)
    return queries.length > 0 ? queries : [question]
  } catch {
    return [question]
  }
}

export async function ragQuery(
  question: string,
  folderPath: string,
  modelId: string,
  history: HistoryMessage[],
  onToken: (token: string) => void,
  onProgress?: (p: ChatProgress) => void,
  sourceFileFilter?: string[],
  task?: 'podcast' | 'overview',
  externalTrace?: LangfuseParent | null
): Promise<RagResult> {
  onProgress?.({ stage: 'reading' })

  const lf = getLangfuse()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelineSpan: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any
  if (externalTrace) {
    pipelineSpan = externalTrace.span({ name: 'rag-query', input: { question } })
    trace = pipelineSpan
  } else {
    trace = lf?.trace({ name: 'rag-query', input: question }) ?? null
  }

  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  // Expand the question into multiple search queries using the LLM.
  // This handles vague queries ("what ideas did I work on?") and follow-ups
  // ("tell me more about that") by generating semantically richer search terms.
  const expandSpan = trace?.span({ name: 'expand-query', input: { question, historyLength: history.length } })
  const queries = await expandQuery(question, history)
  expandSpan?.update({ output: queries })
  expandSpan?.end()

  // Run all queries through the vector store, then merge and deduplicate by parentId.
  const retrieveSpan = trace?.span({ name: 'retrieve', input: queries })
  const allChunks: SearchResult[] = []
  for (const q of queries) {
    const chunks = await retrieve(q, folderPath, { topK: RETRIEVE_TOP_K, sourceFileFilter })
    for (const chunk of chunks) {
      if (!allChunks.some((c) => c.parentId === chunk.parentId)) {
        allChunks.push(chunk)
      }
    }
  }
  retrieveSpan?.update({
    output: allChunks.map((c, i) => ({
      rank: i,
      score: c.score,
      sourceFile: c.sourceFile,
      pageNumber: c.pageNumber ?? null,
      headingPath: c.headingPath ?? null,
      text: c.text.slice(0, 300),
    })),
  })
  retrieveSpan?.end()

  if (allChunks.length === 0) {
    trace?.update({ output: 'no_chunks_found' })
    lf?.flushAsync().catch(() => {})
    return {
      answer: "I couldn't find any relevant sources in this notebook.",
      citations: [],
    }
  }

  if (rerankerGgufService.isReady()) onProgress?.({ stage: 'reranking' })
  const rerankSpan = trace?.span({
    name: 'rerank',
    input: { candidates: allChunks.length, enabled: rerankerGgufService.isReady() },
  })
  const rerankedChunks = await rerankChunks(question, allChunks)
  const parents = dedupeByParent(rerankedChunks)
  rerankSpan?.update({
    output: parents.map((c, i) => ({
      rank: i + 1,
      score: (c as any)._rerankScore ?? null,
      sourceFile: c.sourceFile,
      text: c.text.slice(0, 200),
    })),
  })
  rerankSpan?.end()

  // Format path: podcast/overview synthesis from retrieved chunks, no citations
  if (task) {
    const sysPrompt = task === 'podcast' ? buildPodcastPrompt(parents) : buildOverviewPrompt(parents)
    onProgress?.({ stage: 'generating' })
    const gen = trace?.generation({
      name: 'llm',
      model: modelId,
      input: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: question },
      ],
    })
    const answer = await llamaService.generateStream(sysPrompt, question, onToken)
    gen?.update({ output: answer })
    gen?.end()
    trace?.update({ output: answer })
    pipelineSpan?.end()
    if (!externalTrace) lf?.flushAsync().catch(() => {})
    return { answer, citations: [] }
  }

  const systemPrompt = buildSystemPrompt(parents, history)

  onProgress?.({ stage: 'generating' })
  const gen = trace?.generation({
    name: 'llm',
    model: modelId,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
  })
  const rawAnswer = await llamaService.generateStream(systemPrompt, question, onToken)
  gen?.update({ output: rawAnswer })
  gen?.end()

  const rawCitations = extractCitations(rawAnswer, parents)

  // Remap [4] → [1] etc. so the UI always shows sequential citation numbers
  // starting from 1 regardless of which retrieval slot the model happened to cite.
  const remap = new Map<number, number>()
  let next = 1
  rawAnswer.replace(/\[(\d+)\]/g, (_, n) => {
    const num = parseInt(n, 10)
    if (rawCitations.some((c) => c.sourceNum === num) && !remap.has(num)) remap.set(num, next++)
    return ''
  })
  const answer = rawAnswer.replace(/\[(\d+)\]/g, (orig, n) => {
    const d = remap.get(parseInt(n, 10))
    return d !== undefined ? `[${d}]` : orig
  })
  const citations = rawCitations
    .filter((c) => remap.has(c.sourceNum))
    .map((c) => ({ ...c, sourceNum: remap.get(c.sourceNum)! }))
    .sort((a, b) => a.sourceNum - b.sourceNum)

  trace?.update({ output: answer })
  pipelineSpan?.end()
  if (!externalTrace) lf?.flushAsync().catch(() => {})

  return { answer, citations }
}

// Targeted summarization: fetch ALL chunks for a specific file and send the full
// content to the LLM. Used when the user's question names a specific document.
export async function ragSummarizeFile(
  question: string,
  sourceFile: string,
  folderPath: string,
  modelId: string,
  history: HistoryMessage[],
  onToken: (token: string) => void,
  onProgress?: (p: ChatProgress) => void,
  externalTrace?: LangfuseParent | null
): Promise<RagResult> {
  onProgress?.({ stage: 'reading' })

  const lf = getLangfuse()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelineSpan: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any
  if (externalTrace) {
    pipelineSpan = externalTrace.span({ name: 'rag-summarize-file', input: { question, sourceFile } })
    trace = pipelineSpan
  } else {
    trace = lf?.trace({ name: 'rag-summarize-file', input: { question, sourceFile } }) ?? null
  }

  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  const dim = embedDim(DEFAULT_EMBED)
  await vectorStore.open(folderPath, { dim })

  const retrieveSpan = trace?.span({ name: 'retrieve-file', input: sourceFile })
  const allChunks = await vectorStore.getChunksByFile(sourceFile)
  retrieveSpan?.update({ output: { count: allChunks.length } })
  retrieveSpan?.end()

  if (allChunks.length === 0) {
    trace?.update({ output: 'no_chunks_found' })
    pipelineSpan?.end()
    if (!externalTrace) lf?.flushAsync().catch(() => {})
    return { answer: "I couldn't find any content for that file.", citations: [] }
  }

  // Sort by chunkIndex so the LLM sees content in document order
  const sorted = allChunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
  const parents = dedupeByParent(sorted)
  const systemPrompt = buildSystemPrompt(parents, history)

  onProgress?.({ stage: 'generating' })
  const gen = trace?.generation({
    name: 'llm',
    model: modelId,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
  })
  const rawAnswer = await llamaService.generateStream(systemPrompt, question, onToken)
  gen?.update({ output: rawAnswer })
  gen?.end()

  const rawCitations = extractCitations(rawAnswer, parents)

  const remap = new Map<number, number>()
  let next = 1
  rawAnswer.replace(/\[(\d+)\]/g, (_, n) => {
    const num = parseInt(n, 10)
    if (rawCitations.some((c) => c.sourceNum === num) && !remap.has(num)) remap.set(num, next++)
    return ''
  })
  const answer = rawAnswer.replace(/\[(\d+)\]/g, (orig, n) => {
    const d = remap.get(parseInt(n, 10))
    return d !== undefined ? `[${d}]` : orig
  })
  const citations = rawCitations
    .filter((c) => remap.has(c.sourceNum))
    .map((c) => ({ ...c, sourceNum: remap.get(c.sourceNum)! }))
    .sort((a, b) => a.sourceNum - b.sourceNum)

  trace?.update({ output: answer })
  pipelineSpan?.end()
  if (!externalTrace) lf?.flushAsync().catch(() => {})

  return { answer, citations }
}
