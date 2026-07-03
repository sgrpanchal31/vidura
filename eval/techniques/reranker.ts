import type { RetrievalTechnique, RetrievalContext, RetrievedChunk } from '../harness/types'
import { embedQuery } from '../harness/embedder'
import { buildCorpusIndex, openCorpusTable } from '../harness/corpus'
import { Index } from '@lancedb/lancedb'
import { join } from 'path'
import { existsSync } from 'fs'
import os from 'os'

// The model must be pre-downloaded via the app's Settings → Retrieval → Download.
// Point OPENBOOK_MODELS_DIR at the app's models folder, e.g.:
//   OPENBOOK_MODELS_DIR=~/Library/Application\ Support/vidura/models npm run eval ...
function getRerankerPath(): string {
  const dir =
    process.env.OPENBOOK_MODELS_DIR ?? join(os.homedir(), 'Library', 'Application Support', 'vidura', 'models')
  return join(dir, 'bge-reranker-v2-m3.gguf')
}

class RerankerTechnique implements RetrievalTechnique {
  name = 'reranker'
  private workDir = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rankingCtx: any = null

  async setup(ctx: RetrievalContext): Promise<void> {
    this.workDir = ctx.workDir
    await buildCorpusIndex(ctx.corpusDir, ctx.workDir)

    const table = await openCorpusTable(this.workDir)
    await (table as any).createIndex('text', {
      config: Index.fts({ language: 'English', stem: true }),
      replace: true,
    })

    const modelPath = getRerankerPath()
    if (!existsSync(modelPath)) {
      console.warn(`  [reranker] model not found at ${modelPath} — reranking disabled`)
      console.warn('  [reranker] Download via Settings → Retrieval, then set OPENBOOK_MODELS_DIR')
      return
    }

    const { getLlama } = await import('node-llama-cpp')
    console.log('  [reranker] loading bge-reranker-v2-m3…')
    const llama = await getLlama()
    const model = await llama.loadModel({ modelPath })
    this.rankingCtx = await model.createRankingContext()
    console.log('  [reranker] model ready')
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    const table = await openCorpusTable(this.workDir)
    const queryVector = await embedQuery(query)

    // Retrieve a larger pool for the reranker to work with (mirrors production rag.ts)
    const candidateK = Math.max(30, topK * 6)

    // Hybrid-RRF retrieval to get candidates
    const [denseRows, ftsRows] = await Promise.all([
      (async () => {
        try {
          return await (table.search(queryVector) as any).distanceType('cosine').limit(candidateK).toArray()
        } catch {
          return []
        }
      })(),
      (async () => {
        try {
          return await (table.query() as any).fullTextSearch(query, { columns: 'text' }).limit(candidateK).toArray()
        } catch {
          return []
        }
      })(),
    ])

    // Reciprocal Rank Fusion
    const scores = new Map<string, number>()
    const byId = new Map<string, any>()
    const k = 60
    for (const list of [denseRows, ftsRows] as any[][]) {
      list.forEach((row: any, rank: number) => {
        const id = row.id as string
        scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
        if (!byId.has(id)) byId.set(id, row)
      })
    }

    const rrfCandidates = [...byId.values()].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!).slice(0, candidateK)

    if (rrfCandidates.length === 0 || !this.rankingCtx) {
      return rrfCandidates.map((row, idx) => ({
        id: row.id as string,
        text: row.text as string,
        sourceFile: row.sourceFile as string,
        score: scores.get(row.id as string) ?? 0,
        rank: idx + 1,
      }))
    }

    // Rerank: cross-encoder scores all (query, passage) pairs in one call
    const docs = rrfCandidates.map((row) => (row.text as string).slice(0, 2000))
    const rerankScores: number[] = await this.rankingCtx.rankAll(query, docs)

    return rrfCandidates
      .map((row, i) => ({ row, rerankScore: rerankScores[i] ?? 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK)
      .map((item, idx) => ({
        id: item.row.id as string,
        text: item.row.text as string,
        sourceFile: item.row.sourceFile as string,
        score: item.rerankScore,
        rank: idx + 1,
      }))
  }

  async teardown(): Promise<void> {
    await this.rankingCtx?.dispose().catch(() => {})
    this.rankingCtx = null
  }
}

export const rerankerTechnique = new RerankerTechnique()
