export type RetrievedChunk = {
  id: string
  text: string
  sourceFile: string
  score: number
  rank: number // 1-indexed final rank after any reordering
  vectorScore?: number // raw cosine similarity before reranking
  bm25Score?: number
  rerankScore?: number
}

export type DatasetEntry = {
  id: string
  question: string
  expectedChunkIds?: string[] // exact chunk ids (sha256 prefix) that answer the question
  expectedSubstring?: string // a string that must appear in the retrieved text
  expectedSourceFiles?: string[] // at least one of these files must appear in top-k
  meta?: Record<string, unknown>
}

export type RetrievalContext = {
  corpusDir: string // folder containing the documents to retrieve from
  workDir: string // scratch dir for this technique's index: .openbook/eval/<technique>/<configHash>/
}

export interface RetrievalTechnique {
  name: string
  // Build indices, warm models, etc. Must be idempotent (re-running skips existing work).
  setup(ctx: RetrievalContext): Promise<void>
  retrieve(query: string, topK: number): Promise<RetrievedChunk[]>
  teardown?(): Promise<void>
}

export type PerQueryResult = {
  id: string
  question: string
  hitAtK: boolean // did any expected source/chunk appear in top-k?
  reciprocalRank: number // 1/rank of first hit, or 0 if missed
  firstHitRank: number | null
  latencyMs: number
  retrieved: Array<{ id: string; sourceFile: string; score: number }>
}

export type RunAggregates = {
  recallAtK: number // mean hitAtK
  mrr: number // mean reciprocal rank
  p50Ms: number
  p95Ms: number
  totalQueries: number
  hitsCount: number
}

export type RunResult = {
  timestamp: string
  dataset: string
  technique: string
  topK: number
  aggregates: RunAggregates
  queries: PerQueryResult[]
}
