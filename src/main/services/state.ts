import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

const OPENBOOK_DIR = '.openbook'

export type FileRecord = {
  relativePath: string
  hash: string
  lastIndexed: number
  chunkCount: number
  embeddingModel?: string // absent = not yet embedded
  parserVersion?: string // absent = pre-v2; if version changes, file is re-indexed
  failed?: boolean
  failReason?: string
}

export type NotebookState = {
  version: 1
  embeddingModel?: string // HF id of the model used for this folder; absent = default
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

// ── Chat sessions ─────────────────────────────────────────────────────────────

export type PersistedMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: unknown[] // CitationEntry[] — typed on the renderer side, opaque here
}

export type ChatSession = {
  id: string
  createdAt: number
  title: string
  messages: PersistedMessage[]
}

function chatsDir(folderPath: string): string {
  return join(folderPath, OPENBOOK_DIR, 'chats')
}

function sessionPath(folderPath: string, sessionId: string): string {
  return join(chatsDir(folderPath), `${sessionId}.json`)
}

export async function listChatSessions(
  folderPath: string
): Promise<Array<{ id: string; createdAt: number; title: string }>> {
  const dir = chatsDir(folderPath)
  try {
    const files = await readdir(dir)
    const sessions: Array<{ id: string; createdAt: number; title: string }> = []
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8')
        const s = JSON.parse(raw) as ChatSession
        sessions.push({ id: s.id, createdAt: s.createdAt, title: s.title })
      } catch {
        // skip corrupt files
      }
    }
    return sessions.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function loadChatSession(folderPath: string, sessionId: string): Promise<ChatSession | null> {
  try {
    const raw = await readFile(sessionPath(folderPath, sessionId), 'utf-8')
    return JSON.parse(raw) as ChatSession
  } catch {
    return null
  }
}

export async function saveChatSession(folderPath: string, session: ChatSession): Promise<void> {
  await ensureOpenbookDir(folderPath)
  await mkdir(chatsDir(folderPath), { recursive: true })
  await writeFile(sessionPath(folderPath, session.id), JSON.stringify(session, null, 2), 'utf-8')
}
