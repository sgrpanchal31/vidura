import { join } from 'path'
import { readFileSync } from 'fs'
import type { DatasetEntry } from '../../harness/types'

const CORPUS_DIR = join(__dirname, 'corpus')
const QA_FILE = join(__dirname, 'qa.json')

type QAEntry = {
  id: string
  question: string
  expectedSourceFiles?: string[]
  expectedSubstring?: string
  meta?: Record<string, unknown>
}

export function loadDomain(): { entries: DatasetEntry[]; corpusDir: string } {
  const raw: QAEntry[] = JSON.parse(readFileSync(QA_FILE, 'utf-8'))
  const entries: DatasetEntry[] = raw.map((item) => ({
    id: item.id,
    question: item.question,
    expectedSourceFiles: item.expectedSourceFiles,
    expectedSubstring: item.expectedSubstring,
    meta: item.meta,
  }))
  return { entries, corpusDir: CORPUS_DIR }
}
