import { describe, it, expect } from 'vitest'
import { normalize, substringHit, tokenF1, citationValidity } from './score'

describe('normalize', () => {
  it('lowercases, strips punctuation and citation markers', () => {
    expect(normalize('The score is 28.4 BLEU [1].')).toBe('the score is 284 bleu')
  })
  it('makes formatting variants comparable ("8,192" vs "8192")', () => {
    expect(normalize('8,192')).toBe(normalize('8192'))
  })
})

describe('substringHit', () => {
  it('matches despite punctuation differences', () => {
    expect(substringHit('It reached 28.4 BLEU on the test.', '28.4')).toBe(true)
  })
  it('misses when the fact is absent', () => {
    expect(substringHit('It reached 27.3 BLEU.', '28.4')).toBe(false)
  })
})

describe('tokenF1', () => {
  it('is 1 for identical answers', () => {
    expect(tokenF1('28.4 BLEU', '28.4 BLEU')).toBe(1)
  })
  it('gives partial credit for overlap', () => {
    const f1 = tokenF1('The model achieves 28.4 BLEU on translation', '28.4 BLEU')
    expect(f1).toBeGreaterThan(0.3)
    expect(f1).toBeLessThan(1)
  })
  it('is 0 for disjoint answers', () => {
    expect(tokenF1('completely unrelated words', 'BLEU 28.4')).toBe(0)
  })
})

describe('citationValidity', () => {
  it('is the fraction of cited passages containing the fact', () => {
    expect(citationValidity(['has 28.4 inside', 'does not'], '28.4')).toBe(0.5)
  })
  it('is null when nothing was cited', () => {
    expect(citationValidity([], '28.4')).toBeNull()
  })
})
