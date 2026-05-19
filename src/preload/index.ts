import { contextBridge, ipcRenderer } from 'electron'

export type Prefs = {
  lastFolder: string | null
  modelId: string | null
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
  text: string
  sourceFile: string
  chunkIndex: number
  pageNumber?: number
  headingAnchor?: string
  lineNumber?: number
  score: number
}

export type ModelProgress = {
  modelId: string
  downloaded: number
  total: number
}

export type CitationEntry = {
  sourceNum: number
  chunk: SearchResult
}

export type ChatResult = {
  answer: string
  citations: CitationEntry[]
}

const api = {
  // ── Folder + prefs ──────────────────────────────────────────────────────────
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickFolder'),
  getPrefs: (): Promise<Prefs> =>
    ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch: Partial<Prefs>): Promise<void> =>
    ipcRenderer.invoke('prefs:set', patch),
  getSystemInfo: (): Promise<SystemInfo> =>
    ipcRenderer.invoke('system:info'),

  // ── Ingest ──────────────────────────────────────────────────────────────────
  startIngest: (folderPath: string): Promise<IndexSummary> =>
    ipcRenderer.invoke('ingest:start', folderPath),
  getIngestState: (folderPath: string): Promise<unknown> =>
    ipcRenderer.invoke('ingest:getState', folderPath),
  onIngestProgress: (cb: (p: IndexProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: IndexProgress) => cb(p)
    ipcRenderer.on('ingest:progress', handler)
    return () => ipcRenderer.off('ingest:progress', handler)
  },

  // ── Search ──────────────────────────────────────────────────────────────────
  searchQuery: (query: string, topK?: number): Promise<SearchResult[]> =>
    ipcRenderer.invoke('search:query', query, topK),

  // ── Model management ────────────────────────────────────────────────────────
  modelIsDownloaded: (modelId: string): Promise<boolean> =>
    ipcRenderer.invoke('model:isDownloaded', modelId),
  modelDownload: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('model:download', modelId),
  modelLoad: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('model:load', modelId),
  modelUnload: (): Promise<void> =>
    ipcRenderer.invoke('model:unload'),
  onModelProgress: (cb: (p: ModelProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: ModelProgress) => cb(p)
    ipcRenderer.on('model:progress', handler)
    return () => ipcRenderer.off('model:progress', handler)
  },

  // ── Chat / RAG ──────────────────────────────────────────────────────────────
  // chatAsk resolves immediately; tokens arrive via onChatToken, completion via onChatDone
  chatAsk: (question: string, folderPath: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('chat:ask', question, folderPath, modelId),
  chatCancel: (): Promise<void> =>
    ipcRenderer.invoke('chat:cancel'),
  onChatToken: (cb: (token: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, token: string) => cb(token)
    ipcRenderer.on('chat:token', handler)
    return () => ipcRenderer.off('chat:token', handler)
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
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (err) {
    console.error(err)
  }
} else {
  // @ts-ignore
  window.api = api
}
