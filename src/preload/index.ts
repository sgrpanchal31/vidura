import { contextBridge, ipcRenderer } from 'electron'

export type PodcastVoices = { hostA: string; hostB: string; solo: string }

// A newer GitHub release the app can update itself to
export type UpdateInfo = { version: string; url: string }

export type Prefs = {
  lastFolder: string | null
  modelId: string | null
  rerankerEnabled: boolean
  ttsEngine: string | null
  podcastVoices: PodcastVoices | null
  // Escape hatch: false routes chat through the old router+RAG pipeline
  // instead of the agent loop. Kept for one release as a safety valve.
  agentEnabled?: boolean
}

export type LlmModelInfo = {
  id: string
  filename: string
  sizeBytes: number
  downloaded: boolean
}

export type EmbedModelInfo = {
  hfId: string
  name: string
  desc: string
  sizeLabel: string
  dim: number
  recommended: boolean
  tags: string[]
  downloaded: boolean
}

export type FileRecord = {
  relativePath: string
  hash: string
  lastIndexed: number
  chunkCount: number
  embeddingModel?: string
  parserVersion?: string
  failed?: boolean
  failReason?: string
}

export type NotebookState = {
  version: 1
  embeddingModel?: string
  files: Record<string, FileRecord>
}

export type SystemInfo = {
  totalRamGB: number
  platform: NodeJS.Platform
}

export type IndexProgress = {
  stage: 'scanning' | 'hashing' | 'parsing' | 'model_load' | 'embedding' | 'done'
  processed: number
  total: number
  currentFile?: string
}

export type IndexSummary = {
  total: number
  indexed: number
  upToDate: number
  failed: number
  chunks: number
  totalChunks: number
}

export type SearchResult = {
  id: string
  text: string // child chunk — what was matched
  parentText: string // parent unit — shown to the LLM for context
  parentId: string
  sourceFile: string
  chunkIndex: number
  pageNumber?: number
  headingAnchor?: string
  headingPath?: string
  lineNumber?: number
  score: number
}

export type GenerateTask = 'overview' | 'podcast' | 'facts'
export type GenerateFormat = 'prose' | 'mermaid' | 'facts-json'
export type GenerateProgress = { stage: 'map' } | { stage: 'reduce' } | { stage: 'final'; type: GenerateTask }
export type ChatProgress = { stage: 'reading' } | { stage: 'reranking' } | { stage: 'generating' }

export type ModelProgress = {
  modelId: string
  downloaded: number
  total: number
}

export type CitationEntry = {
  sourceNum: number
  chunk: SearchResult
}

export type MessageAudio = {
  file: string // relative to notebook folder
  durationSec: number
  chapters: Array<{ title: string; startSec: number }>
}

// One executed agent step, persisted with its message so the trace survives
// session reloads. Mirrors AgentStepRecord in main/services/agent/types.ts.
export type AgentStepRecord = {
  step: number
  thought: string
  tool: string
  params: Record<string, unknown>
  summary: string
  evidenceCount: number
  durationMs: number
  isError?: boolean
}

// Live step events streamed while an agent run is in progress (chat:step)
export type AgentStepEvent =
  | { type: 'step_start'; step: number; thought: string; tool: string; params: Record<string, unknown> }
  | {
      type: 'step_result'
      step: number
      tool: string
      summary: string
      evidenceCount: number
      durationMs: number
      isError?: boolean
    }
  | { type: 'answer_start' }

export type ChatSession = {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  type?: 'chat' | 'podcast'
  selectedFiles?: string[]
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    citations: CitationEntry[]
    audio?: MessageAudio
    steps?: AgentStepRecord[]
  }>
}

export type ChatResult = {
  answer: string
  citations: CitationEntry[]
  // The agent steps that produced this answer (absent on the old pipeline)
  steps?: AgentStepRecord[]
  // Present when this was a podcast task: main will follow up with podcast:progress
  // events and attach audio to the message with this id via podcast:done
  podcast?: { sessionId: string; messageId: string }
}

export type PodcastProgress = { sessionId: string; messageId: string } & (
  | { stage: 'model_download'; loaded: number; total: number }
  | { stage: 'loading' }
  | { stage: 'synthesizing'; done: number; total: number }
  | { stage: 'writing' }
)

export type PodcastDone = { sessionId: string; messageId: string; audio: MessageAudio }
export type PodcastError = { sessionId: string; messageId: string; cancelled: boolean; error: string }

// Sent once per chat:ask as soon as the router has classified the query
export type ChatRouted = { task: 'chat' | 'podcast' | 'overview' }

const api = {
  // ── Folder + prefs ──────────────────────────────────────────────────────────
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  getPrefs: (): Promise<Prefs> => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch: Partial<Prefs>): Promise<void> => ipcRenderer.invoke('prefs:set', patch),
  getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke('system:info'),

  // ── App version + updates ───────────────────────────────────────────────────
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  updateCheck: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),
  updateInstall: (url: string): Promise<void> => ipcRenderer.invoke('update:install', url),
  onUpdateProgress: (cb: (p: { loaded: number; total: number }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: { loaded: number; total: number }) => cb(p)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.off('update:progress', handler)
  },

  // ── Ingest ──────────────────────────────────────────────────────────────────
  getParserVersion: (): Promise<string> => ipcRenderer.invoke('ingest:parserVersion'),
  startIngest: (folderPath: string, embeddingModel?: string): Promise<IndexSummary> =>
    ipcRenderer.invoke('ingest:start', folderPath, embeddingModel),
  getIngestState: (folderPath: string): Promise<NotebookState> => ipcRenderer.invoke('ingest:getState', folderPath),
  onIngestProgress: (cb: (p: IndexProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: IndexProgress) => cb(p)
    ipcRenderer.on('ingest:progress', handler)
    return () => ipcRenderer.off('ingest:progress', handler)
  },
  onWatchStatus: (cb: (status: { active: boolean }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, s: { active: boolean }) => cb(s)
    ipcRenderer.on('watch:status', handler)
    return () => ipcRenderer.off('watch:status', handler)
  },

  // ── Search ──────────────────────────────────────────────────────────────────
  searchQuery: (query: string, topK?: number): Promise<SearchResult[]> =>
    ipcRenderer.invoke('search:query', query, topK),

  // ── Model management ────────────────────────────────────────────────────────
  modelIsDownloaded: (modelId: string): Promise<boolean> => ipcRenderer.invoke('model:isDownloaded', modelId),
  modelDownload: (modelId: string): Promise<void> => ipcRenderer.invoke('model:download', modelId),
  modelLoad: (modelId: string): Promise<void> => ipcRenderer.invoke('model:load', modelId),
  modelUnload: (): Promise<void> => ipcRenderer.invoke('model:unload'),
  onModelProgress: (cb: (p: ModelProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: ModelProgress) => cb(p)
    ipcRenderer.on('model:progress', handler)
    return () => ipcRenderer.off('model:progress', handler)
  },
  modelCancelDownload: (): Promise<void> => ipcRenderer.invoke('model:cancelDownload'),
  listModels: (): Promise<LlmModelInfo[]> => ipcRenderer.invoke('model:list'),
  modelDelete: (modelId: string): Promise<void> => ipcRenderer.invoke('model:delete', modelId),

  // ── Embed model management ───────────────────────────────────────────────────
  listEmbedModels: (): Promise<EmbedModelInfo[]> => ipcRenderer.invoke('embed:list'),
  embedEnsure: (): Promise<void> => ipcRenderer.invoke('embed:ensure'),
  embedDownload: (hfId: string): Promise<void> => ipcRenderer.invoke('embed:download', hfId),
  embedDelete: (hfId: string): Promise<void> => ipcRenderer.invoke('embed:delete', hfId),
  onEmbedDownloadProgress: (cb: (p: { hfId: string; loaded: number; total: number }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: { hfId: string; loaded: number; total: number }) => cb(p)
    ipcRenderer.on('embed:downloadProgress', handler)
    return () => ipcRenderer.off('embed:downloadProgress', handler)
  },

  // ── Reranker ────────────────────────────────────────────────────────────────
  rerankerGetStatus: (): Promise<{ enabled: boolean; status: string; downloaded: boolean }> =>
    ipcRenderer.invoke('reranker:getStatus'),
  rerankerSetEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('reranker:setEnabled', enabled),

  // ── Chat / RAG ──────────────────────────────────────────────────────────────
  // chatAsk resolves immediately; tokens arrive via onChatToken, completion via onChatDone
  chatAsk: (
    question: string,
    folderPath: string,
    modelId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    selectedFiles?: string[],
    sessionId?: string
  ): Promise<void> => ipcRenderer.invoke('chat:ask', question, folderPath, modelId, history, selectedFiles, sessionId),
  chatCancel: (): Promise<void> => ipcRenderer.invoke('chat:cancel'),
  onChatProgress: (cb: (p: ChatProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: ChatProgress) => cb(p)
    ipcRenderer.on('chat:progress', handler)
    return () => ipcRenderer.off('chat:progress', handler)
  },
  onChatToken: (cb: (token: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, token: string) => cb(token)
    ipcRenderer.on('chat:token', handler)
    return () => ipcRenderer.off('chat:token', handler)
  },
  onChatRouted: (cb: (r: ChatRouted) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, r: ChatRouted) => cb(r)
    ipcRenderer.on('chat:routed', handler)
    return () => ipcRenderer.off('chat:routed', handler)
  },
  onChatStep: (cb: (e: AgentStepEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, e: AgentStepEvent) => cb(e)
    ipcRenderer.on('chat:step', handler)
    return () => ipcRenderer.off('chat:step', handler)
  },
  onChatDone: (cb: (result: ChatResult) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, result: ChatResult) => cb(result)
    ipcRenderer.on('chat:done', handler)
    return () => ipcRenderer.off('chat:done', handler)
  },
  onChatError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on('chat:error', handler)
    return () => ipcRenderer.off('chat:error', handler)
  },
  chatSessionList: (
    folderPath: string
  ): Promise<Array<{ id: string; createdAt: number; updatedAt: number; title: string; type?: 'chat' | 'podcast' }>> =>
    ipcRenderer.invoke('chat:session:list', folderPath),
  chatSessionLoad: (folderPath: string, sessionId: string): Promise<ChatSession | null> =>
    ipcRenderer.invoke('chat:session:load', folderPath, sessionId),
  chatSessionSave: (folderPath: string, session: ChatSession): Promise<void> =>
    ipcRenderer.invoke('chat:session:save', folderPath, session),
  chatSessionDelete: (folderPath: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('chat:session:delete', folderPath, sessionId),

  setWindowSize: (width: number, height: number): Promise<void> => ipcRenderer.invoke('window:setSize', width, height),

  // ── Generation (map-reduce over full corpus) ─────────────────────────────
  // generateRun resolves immediately; tokens arrive via onGenerateToken, completion via onGenerateDone
  generateRun: (
    folderPath: string,
    modelId: string,
    task: GenerateTask,
    format: GenerateFormat,
    selectedFiles?: string[]
  ): Promise<void> => ipcRenderer.invoke('generate:run', folderPath, modelId, task, format, selectedFiles),
  generateCancel: (): Promise<void> => ipcRenderer.invoke('chat:cancel'), // reuses the same LlamaService cancel
  onGenerateProgress: (cb: (p: GenerateProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: GenerateProgress) => cb(p)
    ipcRenderer.on('generate:progress', handler)
    return () => ipcRenderer.off('generate:progress', handler)
  },
  onGenerateToken: (cb: (token: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, token: string) => cb(token)
    ipcRenderer.on('generate:token', handler)
    return () => ipcRenderer.off('generate:token', handler)
  },
  onGenerateDone: (cb: (result: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, result: string) => cb(result)
    ipcRenderer.on('generate:done', handler)
    return () => ipcRenderer.off('generate:done', handler)
  },
  onGenerateError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on('generate:error', handler)
    return () => ipcRenderer.off('generate:error', handler)
  },

  // ── Podcast audio ───────────────────────────────────────────────────────────
  podcastCancel: (sessionId: string): Promise<void> => ipcRenderer.invoke('podcast:cancel', sessionId),
  audioRead: (folderPath: string, relFile: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('audio:read', folderPath, relFile),
  audioSaveAs: (folderPath: string, relFile: string): Promise<string | null> =>
    ipcRenderer.invoke('audio:saveAs', folderPath, relFile),
  onPodcastProgress: (cb: (p: PodcastProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: PodcastProgress) => cb(p)
    ipcRenderer.on('podcast:progress', handler)
    return () => ipcRenderer.off('podcast:progress', handler)
  },
  onPodcastDone: (cb: (p: PodcastDone) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: PodcastDone) => cb(p)
    ipcRenderer.on('podcast:done', handler)
    return () => ipcRenderer.off('podcast:done', handler)
  },
  onPodcastError: (cb: (p: PodcastError) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: PodcastError) => cb(p)
    ipcRenderer.on('podcast:error', handler)
    return () => ipcRenderer.off('podcast:error', handler)
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (err) {
    console.error(err)
  }
} else {
  // contextBridge unavailable (dev/test). env.d.ts extends Window in the renderer
  // context but not here — cast to bypass the type gap.
  ;(window as any).api = api
}
