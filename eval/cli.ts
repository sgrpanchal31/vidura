/**
 * Retrieval evaluation CLI
 *
 * Usage:
 *   npm run eval -- --dataset longmemeval --technique baseline
 *   npm run eval -- --dataset longmemeval --technique baseline,rerank --topk 5 --limit 50
 *   npm run eval -- --download
 *
 * Options:
 *   --dataset    Dataset name: longmemeval (required unless --download)
 *   --technique  Comma-separated technique names: baseline,rerank,hybrid (default: baseline)
 *   --topk       Number of chunks to retrieve (default: 5)
 *   --limit      Run only first N queries (useful for quick smoke tests)
 *   --download   Download required dataset files and exit
 */

import { downloadLongMemEval } from './datasets/longmemeval/download'
import { loadLongMemEval } from './datasets/longmemeval/loader'
// variant flag for longmemeval: 'oracle' (15MB, quick dev), 's' (278MB, real benchmark)
import { runEval } from './harness/runner'
import { baseline } from './techniques/baseline'
import { structured } from './techniques/structured'
import type { RetrievalTechnique } from './harness/types'
import { join } from 'path'

const TECHNIQUES: Record<string, RetrievalTechnique> = {
  baseline,
  structured,
  // Add more here as Phase 3 progresses:
  // rerank: rerank,
  // 'hybrid-rrf': hybridRRF,
  // mmr: mmr,
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      args[key] = val
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.download === 'true') {
    const variant = args.variant ?? 'oracle'
    console.log('[cli] Downloading datasets...')
    await downloadLongMemEval(variant)
    console.log('[cli] Done.')
    return
  }

  const datasetName = args.dataset
  if (!datasetName) {
    console.error('Usage: npm run eval -- --dataset <name> [--technique <names>] [--topk N] [--limit N]')
    console.error('       npm run eval -- --download')
    process.exit(1)
  }

  const techniqueNames = (args.technique ?? 'baseline').split(',').map((t) => t.trim())
  const topK = parseInt(args.topk ?? '5', 10)
  const limit = args.limit ? parseInt(args.limit, 10) : undefined
  const workRoot = join(process.cwd(), '.openbook', 'eval')

  // Load dataset
  let entries: Awaited<ReturnType<typeof loadLongMemEval>>['entries']
  let corpusDir: string

  if (datasetName === 'longmemeval') {
    const variant = args.variant ?? 'oracle'
    const loaded = loadLongMemEval(variant)
    entries = loaded.entries
    corpusDir = loaded.corpusDir
  } else {
    console.error(`Unknown dataset: ${datasetName}. Available: longmemeval`)
    process.exit(1)
  }

  console.log(`[cli] dataset=${datasetName}  entries=${entries.length}  topK=${topK}${limit ? `  limit=${limit}` : ''}`)

  // Run each technique
  for (const name of techniqueNames) {
    const technique = TECHNIQUES[name]
    if (!technique) {
      console.error(`Unknown technique: ${name}. Available: ${Object.keys(TECHNIQUES).join(', ')}`)
      process.exit(1)
    }

    const result = await runEval({
      dataset: datasetName,
      datasetEntries: entries,
      corpusDir,
      technique,
      topK,
      workRoot,
      limit,
    })

    const { aggregates: a } = result
    console.log(`\n=== ${name} @ ${datasetName} (k=${topK}) ===`)
    console.log(`  Recall@${topK}: ${(a.recallAtK * 100).toFixed(1)}%`)
    console.log(`  MRR:          ${(a.mrr * 100).toFixed(1)}%`)
    console.log(`  Latency p50:  ${a.p50Ms}ms  p95: ${a.p95Ms}ms`)
    console.log(`  Hits:         ${a.hitsCount}/${a.totalQueries}`)
  }

  console.log('\n[cli] Results written to eval/results/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
