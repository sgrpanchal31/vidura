import { describe, it, expect } from 'vitest'
import { scoreOne, aggregate } from './metrics'
import type { DatasetEntry, RetrievedChunk, PerQueryResult } from './types'

// Helper: build a realistic RetrievedChunk without repeating all fields each time
const makeChunk = (overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: 'chunk-1',
  text: 'The capital of France is Paris.',
  sourceFile: 'docs/geography.md',
  score: 0.9,
  rank: 1,
  ...overrides,
})

// ─── scoreOne ────────────────────────────────────────────────────────────────
// scoreOne checks whether a single query was answered by the retrieved chunks.
// It supports three match strategies: exact chunk id, substring in text, or
// source file path suffix.

describe('scoreOne', () => {
  it('scores a hit when expectedSubstring appears in a chunk (case-insensitive)', () => {
    const entry: DatasetEntry = { id: 'q1', question: 'Capital of France?', expectedSubstring: 'paris' }
    const result = scoreOne(entry, [makeChunk()], 50)
    expect(result.hitAtK).toBe(true)
    expect(result.reciprocalRank).toBe(1) // hit at rank 1 → 1/1
    expect(result.firstHitRank).toBe(1)
    expect(result.latencyMs).toBe(50)
  })

  it('scores a miss when the substring is absent', () => {
    const entry: DatasetEntry = { id: 'q2', question: 'Capital of Germany?', expectedSubstring: 'Berlin' }
    const result = scoreOne(entry, [makeChunk()], 50)
    expect(result.hitAtK).toBe(false)
    expect(result.reciprocalRank).toBe(0)
    expect(result.firstHitRank).toBeNull()
  })

  it('reports 1/rank as reciprocalRank for a hit at rank 3', () => {
    const entry: DatasetEntry = { id: 'q3', question: 'Find Paris', expectedSubstring: 'Paris' }
    const chunks = [
      makeChunk({ id: 'a', text: 'London is in the UK.', rank: 1 }),
      makeChunk({ id: 'b', text: 'Rome is in Italy.', rank: 2 }),
      makeChunk({ id: 'c', text: 'Paris is in France.', rank: 3 }),
    ]
    const result = scoreOne(entry, chunks, 100)
    expect(result.hitAtK).toBe(true)
    expect(result.reciprocalRank).toBeCloseTo(1 / 3)
    expect(result.firstHitRank).toBe(3)
  })

  it('scores a hit by expectedSourceFiles when the file path contains the expected suffix', () => {
    const entry: DatasetEntry = { id: 'q4', question: 'Anything?', expectedSourceFiles: ['geography.md'] }
    const result = scoreOne(entry, [makeChunk()], 30)
    expect(result.hitAtK).toBe(true)
  })

  it('scores a hit by exact chunk id match', () => {
    const entry: DatasetEntry = { id: 'q5', question: 'By id?', expectedChunkIds: ['chunk-1'] }
    const result = scoreOne(entry, [makeChunk()], 20)
    expect(result.hitAtK).toBe(true)
  })
})

// ─── aggregate ───────────────────────────────────────────────────────────────
// aggregate summarises a list of per-query results into Recall@k, MRR,
// and latency percentiles.

describe('aggregate', () => {
  it('returns all-zero aggregates for an empty result list', () => {
    const agg = aggregate([])
    expect(agg.recallAtK).toBe(0)
    expect(agg.mrr).toBe(0)
    expect(agg.totalQueries).toBe(0)
    expect(agg.hitsCount).toBe(0)
  })

  it('recallAtK = 1 and correct MRR when every query is a hit', () => {
    const results: PerQueryResult[] = [
      { id: 'q1', question: '', hitAtK: true, reciprocalRank: 1, firstHitRank: 1, latencyMs: 10, retrieved: [] },
      { id: 'q2', question: '', hitAtK: true, reciprocalRank: 0.5, firstHitRank: 2, latencyMs: 20, retrieved: [] },
    ]
    const agg = aggregate(results)
    expect(agg.recallAtK).toBe(1)
    expect(agg.hitsCount).toBe(2)
    expect(agg.mrr).toBeCloseTo(0.75) // (1 + 0.5) / 2
  })

  it('recallAtK = 0 and MRR = 0 when every query misses', () => {
    const results: PerQueryResult[] = [
      { id: 'q1', question: '', hitAtK: false, reciprocalRank: 0, firstHitRank: null, latencyMs: 15, retrieved: [] },
    ]
    const agg = aggregate(results)
    expect(agg.recallAtK).toBe(0)
    expect(agg.mrr).toBe(0)
    expect(agg.hitsCount).toBe(0)
  })

  it('computes p50 and p95 latency from sorted percentile positions', () => {
    // 10 queries with latencies 10, 20, ..., 100 ms
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const results: PerQueryResult[] = latencies.map((ms, i) => ({
      id: `q${i}`,
      question: '',
      hitAtK: true,
      reciprocalRank: 1,
      firstHitRank: 1,
      latencyMs: ms,
      retrieved: [],
    }))
    const agg = aggregate(results)
    // floor(10 * 0.50) = 5  → sorted[5] = 60
    expect(agg.p50Ms).toBe(60)
    // floor(10 * 0.95) = 9  → sorted[9] = 100
    expect(agg.p95Ms).toBe(100)
  })
})
