// Rescores saved runner JSONs with the current score.ts and prints the
// agent-vs-rag comparison table.
// Usage: npx tsx eval/agent/compare.mts <agent-results.json> <rag-results.json>
import { readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { substringHit, tokenF1 } from './score'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..', '..')

type QA = { id: string; question: string; expectedSubstring: string; meta: { answer: string; multiHop?: boolean } }
const qa: QA[] = JSON.parse(readFileSync(join(ROOT, 'eval', 'datasets', 'domain', 'qa.json'), 'utf-8'))
const byId = new Map(qa.map((q) => [q.id, q]))

type Row = { id: string; multiHop: boolean; latencyMs: number; stepCount?: number; answer: string; citationValidity: number | null }

function load(path: string): { pipeline: string; rows: Row[] } {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function rescore(rows: Row[]): Array<Row & { hit: boolean; f1: number }> {
  return rows.map((r) => {
    const entry = byId.get(r.id)!
    return { ...r, hit: substringHit(r.answer, entry.expectedSubstring), f1: tokenF1(r.answer, entry.meta.answer) }
  })
}

const p50 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

const arms = process.argv.slice(2).map((p) => {
  const data = load(p)
  return { name: data.pipeline, rows: rescore(data.rows) }
})

console.log('subset    | arm   | n  | hit  | f1    | cit  | p50s')
console.log('----------|-------|----|------|-------|------|-----')
for (const [subset, filter] of [
  ['all', (): boolean => true],
  ['simple', (r: Row): boolean => !r.multiHop],
  ['multihop', (r: Row): boolean => r.multiHop],
] as Array<[string, (r: Row) => boolean]>) {
  for (const arm of arms) {
    const set = arm.rows.filter(filter)
    if (set.length === 0) continue
    const hit = ((set.filter((r) => r.hit).length / set.length) * 100).toFixed(0) + '%'
    const f1 = avg(set.map((r) => r.f1)).toFixed(3)
    const cit = avg(set.filter((r) => r.citationValidity !== null).map((r) => r.citationValidity!)).toFixed(2)
    const lat = (p50(set.map((r) => r.latencyMs)) / 1000).toFixed(1)
    console.log(
      `${subset.padEnd(9)} | ${arm.name.padEnd(5)} | ${String(set.length).padEnd(2)} | ${hit.padEnd(4)} | ${f1} | ${cit} | ${lat}`
    )
  }
}

// Per-question diff: where the arms disagree
if (arms.length === 2) {
  const [a, b] = arms
  console.log(`\nDisagreements (${a.name} vs ${b.name}):`)
  for (const ra of a.rows) {
    const rb = b.rows.find((r) => r.id === ra.id)
    if (rb && ra.hit !== rb.hit) {
      console.log(` ${ra.id}${ra.multiHop ? ' [mh]' : ''}: ${a.name}=${ra.hit ? 'HIT' : 'miss'} ${b.name}=${rb.hit ? 'HIT' : 'miss'}`)
    }
  }
}
