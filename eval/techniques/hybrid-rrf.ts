import type { RetrievalTechnique, RetrievalContext, RetrievedChunk } from '../harness/types'
import { embedQuery } from '../harness/embedder'
import { buildCorpusIndex, openCorpusTable } from '../harness/corpus'
import { Index } from '@lancedb/lancedb'

class HybridRrfTechnique implements RetrievalTechnique {
  name = 'hybrid-rrf'
  private workDir = ''

  async setup(ctx: RetrievalContext): Promise<void> {
    this.workDir = ctx.workDir
    await buildCorpusIndex(ctx.corpusDir, ctx.workDir)
    const table = await openCorpusTable(this.workDir)
    await (table as any).createIndex('text', {
      config: Index.fts({ language: 'English', stem: true }),
      replace: true,
    })
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    const table = await openCorpusTable(this.workDir)
    const queryVector = await embedQuery(query)

    // Dense and BM25 searches in parallel
    const [denseRows, ftsRows] = await Promise.all([
      (async () => {
        try {
          return await (table.search(queryVector) as any).distanceType('cosine').limit(topK).toArray()
        } catch {
          return []
        }
      })(),
      (async () => {
        try {
          return await (table.query() as any).fullTextSearch(query, { columns: 'text' }).limit(topK).toArray()
        } catch {
          return []
        }
      })(),
    ])

    // Reciprocal Rank Fusion (k=60 standard constant)
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

    return [...byId.values()]
      .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
      .slice(0, topK)
      .map((row, idx) => ({
        id: row.id as string,
        text: row.text as string,
        sourceFile: row.sourceFile as string,
        score: scores.get(row.id as string) ?? 0,
        rank: idx + 1,
      }))
  }
}

export const hybridRrf = new HybridRrfTechnique()
