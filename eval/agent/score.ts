// Answer scoring for the agent-vs-pipeline eval. All deterministic:
// substring-hit is the headline gate, token-F1 gives partial credit,
// citation validity checks the answer is grounded where it claims to be.

// SQuAD-style normalization: lowercase, drop punctuation, collapse spaces.
// Applied to BOTH sides of every comparison, so "8,192" matches "8192".
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[\d+\]/g, ' ') // citation markers are not answer content
    .replace(/(\d)[,.](\d)/g, '$1$2') // "8,192"→"8192", "28.4"→"284" (both sides)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Does the answer contain the expected key fact?
export function substringHit(answer: string, expectedSubstring: string): boolean {
  return normalize(answer).includes(normalize(expectedSubstring))
}

// Token overlap F1 against the gold answer (partial credit for near-misses).
export function tokenF1(answer: string, gold: string): number {
  const a = normalize(answer).split(' ').filter(Boolean)
  const g = normalize(gold).split(' ').filter(Boolean)
  if (a.length === 0 || g.length === 0) return 0

  const goldCounts = new Map<string, number>()
  for (const t of g) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1)
  let overlap = 0
  for (const t of a) {
    const c = goldCounts.get(t) ?? 0
    if (c > 0) {
      overlap++
      goldCounts.set(t, c - 1)
    }
  }
  if (overlap === 0) return 0
  const precision = overlap / a.length
  const recall = overlap / g.length
  return (2 * precision * recall) / (precision + recall)
}

// Fraction of cited passages that actually contain the expected fact.
// Catches decorative citations: a right answer citing the wrong passages.
export function citationValidity(citedTexts: string[], expectedSubstring: string): number | null {
  if (citedTexts.length === 0) return null
  const hits = citedTexts.filter((t) => normalize(t).includes(normalize(expectedSubstring)))
  return hits.length / citedTexts.length
}
