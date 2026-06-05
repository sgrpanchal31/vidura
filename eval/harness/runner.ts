import { join } from 'path'
import { mkdirSync } from 'fs'
import { createHash } from 'crypto'
import type { RetrievalTechnique, DatasetEntry, RetrievalContext, RunResult } from './types'
import { scoreOne, aggregate } from './metrics'
import { writeRunResult } from './report'

export type RunOptions = {
  dataset: string
  datasetEntries: DatasetEntry[]
  corpusDir: string
  technique: RetrievalTechnique
  topK: number
  workRoot: string   // e.g. .openbook/eval/
  limit?: number     // cap query count for smoke runs
}

export async function runEval(opts: RunOptions): Promise<RunResult> {
  const { dataset, datasetEntries, corpusDir, technique, topK, workRoot, limit } = opts

  const configHash = createHash('sha256')
    .update(`${topK}:${technique.name}`)
    .digest('hex')
    .slice(0, 8)

  const workDir = join(workRoot, technique.name, configHash)
  mkdirSync(workDir, { recursive: true })

  const ctx: RetrievalContext = { corpusDir, workDir }

  console.log(`\n[runner] technique=${technique.name}  dataset=${dataset}  topK=${topK}`)
  console.log('[runner] setting up...')
  await technique.setup(ctx)

  const entries = limit ? datasetEntries.slice(0, limit) : datasetEntries
  console.log(`[runner] running ${entries.length} queries`)

  const queryResults = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if ((i + 1) % 50 === 0 || i === 0) {
      process.stdout.write(`  query ${i + 1}/${entries.length}\r`)
    }

    const t0 = performance.now()
    const retrieved = await technique.retrieve(entry.question, topK)
    const latencyMs = Math.round(performance.now() - t0)

    // Assign 1-indexed ranks (technique may already set them; ensure they're set)
    retrieved.forEach((c, idx) => { c.rank = c.rank ?? idx + 1 })

    queryResults.push(scoreOne(entry, retrieved, latencyMs))
  }
  console.log('')

  await technique.teardown?.()

  const aggregates = aggregate(queryResults)
  const result: RunResult = {
    timestamp: new Date().toISOString(),
    dataset,
    technique: technique.name,
    topK,
    aggregates,
    queries: queryResults,
  }

  writeRunResult(result)
  return result
}
