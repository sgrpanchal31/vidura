/// <reference types="vite/client" />

import type {
  Prefs,
  SystemInfo,
  IndexProgress,
  IndexSummary,
  SearchResult,
  ModelProgress,
  ChatResult,
  NotebookState,
  LlmModelInfo,
  EmbedModelInfo,
  GenerateTask,
  GenerateFormat,
} from '../../preload/index'

declare global {
  interface Window {
    api: {
      pickFolder: () => Promise<string | null>
      getPrefs: () => Promise<Prefs>
      setPrefs: (patch: Partial<Prefs>) => Promise<void>
      getSystemInfo: () => Promise<SystemInfo>

      getParserVersion: () => Promise<string>
      startIngest: (folderPath: string, embeddingModel?: string) => Promise<IndexSummary>
      getIngestState: (folderPath: string) => Promise<NotebookState>
      onIngestProgress: (cb: (p: IndexProgress) => void) => () => void

      searchQuery: (query: string, topK?: number) => Promise<SearchResult[]>

      modelIsDownloaded: (modelId: string) => Promise<boolean>
      modelDownload: (modelId: string) => Promise<void>
      modelLoad: (modelId: string) => Promise<void>
      modelUnload: () => Promise<void>
      onModelProgress: (cb: (p: ModelProgress) => void) => () => void
      modelCancelDownload: () => Promise<void>
      listModels: () => Promise<LlmModelInfo[]>
      modelDelete: (modelId: string) => Promise<void>

      listEmbedModels: () => Promise<EmbedModelInfo[]>
      embedEnsure: () => Promise<void>
      embedDownload: (hfId: string) => Promise<void>
      embedDelete: (hfId: string) => Promise<void>
      onEmbedDownloadProgress: (cb: (p: { hfId: string; loaded: number; total: number }) => void) => () => void

      chatAsk: (
        question: string,
        folderPath: string,
        modelId: string,
        history?: Array<{ role: 'user' | 'assistant'; content: string }>
      ) => Promise<void>
      chatCancel: () => Promise<void>
      onChatToken: (cb: (token: string) => void) => () => void
      onChatDone: (cb: (result: ChatResult) => void) => () => void
      onChatError: (cb: (message: string) => void) => () => void

      setWindowSize: (width: number, height: number) => Promise<void>

      generateRun: (folderPath: string, modelId: string, task: GenerateTask, format: GenerateFormat) => Promise<void>
      generateCancel: () => Promise<void>
      onGenerateToken: (cb: (token: string) => void) => () => void
      onGenerateDone: (cb: (result: string) => void) => () => void
      onGenerateError: (cb: (message: string) => void) => () => void
    }
  }
}
