import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import type { RunResult } from './types'

// Results dir relative to project root (where npm run eval is invoked from)
const RESULTS_DIR = join(process.cwd(), 'eval', 'results')

function pad(s: string | number, len: number) {
  return String(s).padEnd(len)
}
function pct(n: number) {
  return (n * 100).toFixed(1) + '%'
}

export function writeRunResult(result: RunResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true })

  const ts = result.timestamp.replace(/[:.]/g, '-').slice(0, 19)
  const filename = `${ts}_${result.technique}_${result.dataset}.json`
  const jsonPath = join(RESULTS_DIR, filename)
  writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  console.log(`[report] wrote ${jsonPath}`)

  appendSummaryRow(result)
}

function appendSummaryRow(result: RunResult): void {
  const summaryPath = join(RESULTS_DIR, 'summary.md')
  const { aggregates: a, timestamp, technique, dataset, topK } = result
  const date = timestamp.slice(0, 10)

  if (!existsSync(summaryPath)) {
    writeFileSync(
      summaryPath,
      [
        '# Retrieval Eval Summary',
        '',
        '| Date       | Technique    | Dataset      |  k | Recall@k |   MRR | p50ms | p95ms | Hits       |',
        '|------------|--------------|--------------|----|---------:|------:|------:|------:|------------|',
      ].join('\n') + '\n'
    )
  }

  const row = `| ${date} | ${pad(technique, 12)} | ${pad(dataset, 12)} | ${String(topK).padStart(2)} | ${pct(a.recallAtK).padStart(8)} | ${pct(a.mrr).padStart(5)} | ${String(a.p50Ms).padStart(5)} | ${String(a.p95Ms).padStart(5)} | ${a.hitsCount}/${a.totalQueries} |`
  appendFileSync(summaryPath, row + '\n')
  console.log('[report] appended to eval/results/summary.md')
}
