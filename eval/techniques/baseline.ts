import type { RetrievalTechnique, RetrievalContext, RetrievedChunk } from '../harness/types'
import { embedQuery } from '../harness/embedder'
import { buildCorpusIndex, openCorpusTable } from '../harness/corpus'

class BaselineTechnique implements RetrievalTechnique {
  name = 'baseline'
  private workDir = ''

  async setup(ctx: RetrievalContext): Promise<void> {
    this.workDir = ctx.workDir
    await buildCorpusIndex(ctx.corpusDir, ctx.workDir)
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    const table = await openCorpusTable(this.workDir)
    const queryVector = await embedQuery(query)

    let rows: any[]
    try {
      rows = await table
        .search(queryVector)
        .distanceType('cosine')
        .limit(topK)
        .toArray()
    } catch {
      return []
    }

    return rows.map((row, idx) => ({
      id: row.id as string,
      text: row.text as string,
      sourceFile: row.sourceFile as string,
      score: Math.max(0, 1 - (row._distance ?? 1)),
      rank: idx + 1,
    }))
  }
}

export const baseline = new BaselineTechnique()
