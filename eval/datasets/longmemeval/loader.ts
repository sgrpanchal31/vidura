/**
 * Loads LongMemEval and normalizes it to DatasetEntry[].
 *
 * LongMemEval schema (confirmed from actual data):
 *   question_id: string
 *   question: string
 *   answer: string
 *   haystack_session_ids: string[]     — session IDs for every session in the haystack
 *   haystack_sessions: Turn[][]        — parallel array; haystack_sessions[i] = turns for haystack_session_ids[i]
 *   answer_session_ids: string[]       — the GOLD session IDs that contain the answer
 *
 * Each turn: { role: 'user'|'assistant', content: string, has_answer: boolean }
 *
 * What we do:
 *   - Write each session as a plain text file: <session_id>.txt in the corpus dir
 *   - Each DatasetEntry.expectedSourceFiles = answer_session_ids (the gold files)
 *   - Scoring: a retrieval hit = at least one gold session file appeared in top-k
 */

import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import type { DatasetEntry } from '../../harness/types'
import { DATA_DIR, dataPath } from './download'

const CORPUS_DIR = join(DATA_DIR, 'corpus')

type Turn = { role: string; content: string; has_answer?: boolean }

type LMEItem = {
  question_id: string
  question: string
  answer: string
  haystack_session_ids: string[]
  haystack_sessions: Turn[][]
  answer_session_ids: string[]
}

export function loadLongMemEval(variant = 'oracle'): {
  entries: DatasetEntry[]
  corpusDir: string
} {
  const file = dataPath(variant)
  if (!existsSync(file)) {
    throw new Error(
      `Dataset not found: ${file}\nRun: npm run eval -- --download${variant !== 'oracle' ? ` --variant ${variant}` : ''}`
    )
  }

  const raw: LMEItem[] = JSON.parse(readFileSync(file, 'utf-8'))
  const variantCorpus = join(CORPUS_DIR, variant)
  mkdirSync(variantCorpus, { recursive: true })

  // Write each unique session as a .txt file (idempotent — skip if exists)
  const seen = new Set<string>()
  for (const item of raw) {
    for (let i = 0; i < item.haystack_session_ids.length; i++) {
      const sid = item.haystack_session_ids[i]
      if (seen.has(sid)) continue
      seen.add(sid)

      const turns = item.haystack_sessions[i] ?? []
      const text = turns.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n')
      const dest = join(variantCorpus, `${sid}.txt`)
      if (!existsSync(dest)) writeFileSync(dest, text)
    }
  }

  console.log(`[loader] ${raw.length} questions, ${seen.size} unique sessions → corpus at ${variantCorpus}`)

  const entries: DatasetEntry[] = raw.map((item, i) => ({
    id: item.question_id ?? `lme-${String(i).padStart(4, '0')}`,
    question: item.question,
    expectedSubstring: item.answer,
    expectedSourceFiles: item.answer_session_ids.map(id => `${id}.txt`),
    meta: { answer: item.answer, answerSessionIds: item.answer_session_ids },
  }))

  return { entries, corpusDir: variantCorpus }
}
