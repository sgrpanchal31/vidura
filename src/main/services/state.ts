import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
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

export type MessageAudio = {
  file: string // relative to notebook folder, e.g. .openbook/audio/<session>-<message>.wav
  durationSec: number
  chapters: Array<{ title: string; startSec: number }>
}

export type PersistedMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: unknown[] // CitationEntry[] — typed on the renderer side, opaque here
  audio?: MessageAudio // generated podcast audio, if any
  steps?: unknown[] // AgentStepRecord[] — the agent trace behind this answer, opaque here
}

export type ChatSession = {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  type?: 'chat' | 'podcast'
  // undefined = all files selected; explicit array = subset of relative paths
  selectedFiles?: string[]
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
): Promise<Array<{ id: string; createdAt: number; updatedAt: number; title: string; type?: 'chat' | 'podcast' }>> {
  const dir = chatsDir(folderPath)
  try {
    const files = await readdir(dir)
    const sessions: Array<{
      id: string
      createdAt: number
      updatedAt: number
      title: string
      type?: 'chat' | 'podcast'
    }> = []
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8')
        const s = JSON.parse(raw) as ChatSession
        if (!s.messages || s.messages.length === 0) continue
        sessions.push({
          id: s.id,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt ?? s.createdAt,
          title: s.title,
          type: s.type,
        })
      } catch {
        // skip corrupt files
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function deleteChatSession(folderPath: string, sessionId: string): Promise<void> {
  try {
    await unlink(sessionPath(folderPath, sessionId))
  } catch {
    // already gone
  }
  // Best-effort cleanup of podcast audio generated for this session
  try {
    const audioDir = join(folderPath, OPENBOOK_DIR, 'audio')
    for (const file of await readdir(audioDir)) {
      if (file.startsWith(`${sessionId}-`)) await unlink(join(audioDir, file))
    }
  } catch {
    // no audio dir or file already gone
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
