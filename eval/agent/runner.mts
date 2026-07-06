// Answer-level eval: the agent loop vs the old RAG pipeline, run headless
// against the domain corpus using the REAL production services (indexer,
// store, embedder worker, reranker, node-llama-cpp).
//
// Usage:
//   npx tsx eval/agent/runner.mts --pipeline agent --model gemma4-e4b
//   npx tsx eval/agent/runner.mts --pipeline rag --model gemma4-e4b --limit 5
//   Flags: --pipeline agent|rag   --model <id>   --limit N   --only multihop
//
// Requires `npm run build` first (the embed worker runs from out/main/).
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..', '..')

// Reuse the app's model cache (LLM ggufs, qwen3 embedder, bge reranker)
if (!process.env.OPENBOOK_MODELS_DIR) {
  const macCache = join(os.homedir(), 'Library', 'Application Support', 'vidura', 'models')
  if (existsSync(macCache)) process.env.OPENBOOK_MODELS_DIR = macCache
}

// Imports come after the env setup on purpose (ESM imports hoist; dynamic
// imports don't), so the services see OPENBOOK_MODELS_DIR.
const { indexFolder } = await import('../../src/main/services/indexer')
const { llamaService } = await import('../../src/main/services/inference')
const { rerankerGgufService } = await import('../../src/main/services/reranker-gguf')
const { ragQuery } = await import('../../src/main/services/rag')
const { runAgent } = await import('../../src/main/services/agent/orchestrator')
const { buildDefaultRegistry } = await import('../../src/main/services/agent/tools')
const { substringHit, tokenF1, citationValidity } = await import('./score')

type QA = { id: string; question: string; expectedSubstring: string; meta: { answer: string; multiHop?: boolean } }

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const pipeline = (flag('pipeline') ?? 'agent') as 'agent' | 'rag'
const modelId = flag('model') ?? 'gemma4-e4b'
const limit = flag('limit') ? parseInt(flag('limit')!, 10) : Infinity
const onlyMultiHop = flag('only') === 'multihop'
const verbose = args.includes('--verbose')

// ── Notebook setup: the domain corpus as a real indexed notebook ──────────
const corpusDir = join(ROOT, 'eval', 'datasets', 'domain', 'corpus')
const notebookDir = join(ROOT, '.openbook', 'eval', 'agent-notebook')
mkdirSync(notebookDir, { recursive: true })
for (const f of readdirSync(corpusDir).filter((f) => f.endsWith('.txt'))) {
  if (!existsSync(join(notebookDir, f))) copyFileSync(join(corpusDir, f), join(notebookDir, f))
}
console.log(`[setup] indexing notebook at ${notebookDir} (incremental)`)
await indexFolder(notebookDir, (p) => {
  if (p.stage === 'embedding' && p.processed % 10 === 0) console.log(`  [index] ${p.stage} ${p.processed}/${p.total}`)
})

// Reranker on for BOTH pipelines — matches production settings
try {
  await rerankerGgufService.start()
  console.log('[setup] reranker ready')
} catch (err) {
  console.log('[setup] reranker unavailable, both arms run without it:', String(err).slice(0, 120))
}

console.log(`[setup] loading LLM ${modelId}`)
await llamaService.loadModel(modelId)

// ── Run ───────────────────────────────────────────────────────────────────
const allQa: QA[] = JSON.parse(readFileSync(join(ROOT, 'eval', 'datasets', 'domain', 'qa.json'), 'utf-8'))
const qa = allQa.filter((q) => !onlyMultiHop || q.meta.multiHop).slice(0, limit)
console.log(`[run] pipeline=${pipeline} model=${modelId} questions=${qa.length}\n`)

type Row = {
  id: string
  multiHop: boolean
  hit: boolean
  f1: number
  citationValidity: number | null
  latencyMs: number
  stepCount?: number
  dispatchedDeliverable?: string
  answer: string
}
const rows: Row[] = []

for (const entry of qa) {
  const t0 = Date.now()
  let answer: string
  let citedTexts: string[] = []
  let stepCount: number | undefined
  let dispatched: string | undefined

  try {
    if (pipeline === 'agent') {
      const result = await runAgent({
        question: entry.question,
        folderPath: notebookDir,
        modelId,
        history: [],
        registry: buildDefaultRegistry(),
        onToken: () => {},
        onStep: (e) => {
          if (verbose && e.type === 'step_start')
            console.log(`    [step ${e.step}] ${e.tool} ${JSON.stringify(e.params)} — ${e.thought}`)
          if (verbose && e.type === 'step_result') console.log(`    [step ${e.step}] → ${e.summary}`)
        },
      })
      answer = result.answer
      citedTexts = result.citations.map((c) => c.chunk.parentText)
      stepCount = result.steps.length
      dispatched = result.deliverable?.tool
    } else {
      const result = await ragQuery(entry.question, notebookDir, modelId, [], () => {})
      answer = result.answer
      citedTexts = result.citations.map((c) => c.chunk.parentText)
    }
  } catch (err) {
    answer = `ERROR: ${String(err).slice(0, 200)}`
  }

  const latencyMs = Date.now() - t0
  const row: Row = {
    id: entry.id,
    multiHop: entry.meta.multiHop ?? false,
    hit: substringHit(answer, entry.expectedSubstring),
    f1: tokenF1(answer, entry.meta.answer),
    citationValidity: citationValidity(citedTexts, entry.expectedSubstring),
    latencyMs,
    ...(stepCount !== undefined ? { stepCount } : {}),
    ...(dispatched ? { dispatchedDeliverable: dispatched } : {}),
    answer,
  }
  rows.push(row)
  console.log(
    `${row.hit ? 'HIT ' : 'MISS'} ${entry.id}${row.multiHop ? ' [mh]' : ''} f1=${row.f1.toFixed(2)} cit=${row.citationValidity?.toFixed(2) ?? '-'} ${(latencyMs / 1000).toFixed(1)}s${stepCount !== undefined ? ` steps=${stepCount}` : ''}${dispatched ? ` DISPATCHED:${dispatched}` : ''}`
  )
}

// ── Summary ───────────────────────────────────────────────────────────────
const pct = (xs: Row[], f: (r: Row) => boolean): string =>
  xs.length === 0 ? '-' : `${((xs.filter(f).length / xs.length) * 100).toFixed(0)}%`
const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const p50 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

const subsets: Array<[string, Row[]]> = [
  ['all', rows],
  ['simple', rows.filter((r) => !r.multiHop)],
  ['multihop', rows.filter((r) => r.multiHop)],
]
console.log(`\n=== ${pipeline} / ${modelId} ===`)
for (const [name, set] of subsets) {
  if (set.length === 0) continue
  console.log(
    `${name.padEnd(9)} n=${String(set.length).padEnd(3)} hit=${pct(set, (r) => r.hit).padEnd(5)} f1=${avg(set.map((r) => r.f1)).toFixed(3)} cit=${avg(set.filter((r) => r.citationValidity !== null).map((r) => r.citationValidity!)).toFixed(2)} p50=${(p50(set.map((r) => r.latencyMs)) / 1000).toFixed(1)}s`
  )
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = join(ROOT, 'eval', 'results', `agent-eval-${pipeline}-${modelId}-${stamp}.json`)
writeFileSync(outPath, JSON.stringify({ pipeline, modelId, rows }, null, 2))
console.log(`\n[saved] ${outPath}`)
process.exit(0)
