import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

const OPENBOOK_DIR = '.openbook'

export type FileRecord = {
  relativePath: string
  hash: string
  lastIndexed: number
  chunkCount: number
  embeddingModel?: string  // absent = not yet embedded; if model changes, file is re-indexed
  failed?: boolean
  failReason?: string
}

export type NotebookState = {
  version: 1
  files: Record<string, FileRecord>
}

const emptyState = (): NotebookState => ({ version: 1, files: {} })

function statePath(folderPath: string): string {
  return join(folderPath, OPENBOOK_DIR, 'state.json')
}

export async function ensureOpenbookDir(folderPath: string): Promise<void> {
  const dir = join(folderPath, OPENBOOK_DIR)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

export async function readState(folderPath: string): Promise<NotebookState> {
  try {
    const raw = await readFile(statePath(folderPath), 'utf-8')
    return JSON.parse(raw) as NotebookState
  } catch {
    return emptyState()
  }
}

export async function writeState(folderPath: string, state: NotebookState): Promise<void> {
  await ensureOpenbookDir(folderPath)
  await writeFile(statePath(folderPath), JSON.stringify(state, null, 2), 'utf-8')
}
