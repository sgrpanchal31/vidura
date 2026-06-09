import type { DatasetEntry, RetrievedChunk, PerQueryResult, RunAggregates } from './types'

export function scoreOne(entry: DatasetEntry, retrieved: RetrievedChunk[], latencyMs: number): PerQueryResult {
  let firstHitRank: number | null = null

  for (const chunk of retrieved) {
    const rankMatches =
      entry.expectedChunkIds?.includes(chunk.id) ||
      (entry.expectedSubstring && chunk.text.toLowerCase().includes(entry.expectedSubstring.toLowerCase())) ||
      entry.expectedSourceFiles?.some((f) => chunk.sourceFile.includes(f))

    if (rankMatches && firstHitRank === null) {
      firstHitRank = chunk.rank
      break
    }
  }

  return {
    id: entry.id,
    question: entry.question,
    hitAtK: firstHitRank !== null,
    reciprocalRank: firstHitRank !== null ? 1 / firstHitRank : 0,
    firstHitRank,
    latencyMs,
    retrieved: retrieved.map((c) => ({ id: c.id, sourceFile: c.sourceFile, score: c.score })),
  }
}

export function aggregate(results: PerQueryResult[]): RunAggregates {
  if (results.length === 0) {
    return { recallAtK: 0, mrr: 0, p50Ms: 0, p95Ms: 0, totalQueries: 0, hitsCount: 0 }
  }

  const latencies = [...results.map((r) => r.latencyMs)].sort((a, b) => a - b)
  const p50Ms = latencies[Math.floor(latencies.length * 0.5)]
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)]

  const hits = results.filter((r) => r.hitAtK)
  const recallAtK = hits.length / results.length
  const mrr = results.reduce((sum, r) => sum + r.reciprocalRank, 0) / results.length

  return {
    recallAtK,
    mrr,
    p50Ms,
    p95Ms,
    totalQueries: results.length,
    hitsCount: hits.length,
  }
}
