/// <reference types="vite/client" />

import type {
  Prefs,
  SystemInfo,
  IndexProgress,
  IndexSummary,
  SearchResult,
  ModelProgress,
  CitationEntry,
  ChatResult,
  NotebookState,
} from '../../preload/index'

declare global {
  interface Window {
    api: {
      pickFolder: () => Promise<string | null>
      getPrefs: () => Promise<Prefs>
      setPrefs: (patch: Partial<Prefs>) => Promise<void>
      getSystemInfo: () => Promise<SystemInfo>

      startIngest: (folderPath: string) => Promise<IndexSummary>
      getIngestState: (folderPath: string) => Promise<NotebookState>
      onIngestProgress: (cb: (p: IndexProgress) => void) => () => void

      searchQuery: (query: string, topK?: number) => Promise<SearchResult[]>

      modelIsDownloaded: (modelId: string) => Promise<boolean>
      modelDownload: (modelId: string) => Promise<void>
      modelLoad: (modelId: string) => Promise<void>
      modelUnload: () => Promise<void>
      onModelProgress: (cb: (p: ModelProgress) => void) => () => void

      chatAsk: (question: string, folderPath: string, modelId: string) => Promise<void>
      chatCancel: () => Promise<void>
      onChatToken: (cb: (token: string) => void) => () => void
      onChatDone: (cb: (result: ChatResult) => void) => () => void
      onChatError: (cb: (message: string) => void) => () => void

      setWindowSize: (width: number, height: number) => Promise<void>
    }
  }
}
