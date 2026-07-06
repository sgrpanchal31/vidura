// Small models hallucinate file names (seen in the smoke test: llama3.2-3b
// invented "roberta.pdf"), so every tool that takes a file path matches
// generously: exact → case-insensitive → basename → unique substring with
// extension ignored ("CLAUDE" → CLAUDE.md).
export function resolveFile(requested: string, files: string[]): string | null {
  if (files.includes(requested)) return requested
  const lower = requested.toLowerCase()
  const ci = files.find((f) => f.toLowerCase() === lower)
  if (ci) return ci
  const base = lower.split('/').pop() ?? lower
  const byBase = files.find((f) => (f.toLowerCase().split('/').pop() ?? '') === base)
  if (byBase) return byBase
  const stem = base.replace(/\.[^.]+$/, '')
  const bySub = files.filter((f) => f.toLowerCase().includes(stem))
  return bySub.length === 1 ? bySub[0] : null
}
