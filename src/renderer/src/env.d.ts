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
  GenerateProgress,
  ChatProgress,
  ChatSession,
  PodcastProgress,
  PodcastDone,
  PodcastError,
  ChatRouted,
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
      onWatchStatus: (cb: (status: { active: boolean }) => void) => () => void

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

      rerankerGetStatus: () => Promise<{ enabled: boolean; status: string; downloaded: boolean }>
      rerankerSetEnabled: (enabled: boolean) => Promise<void>

      onChatProgress: (cb: (p: ChatProgress) => void) => () => void
      chatAsk: (
        question: string,
        folderPath: string,
        modelId: string,
        history?: Array<{ role: 'user' | 'assistant'; content: string }>,
        selectedFiles?: string[],
        sessionId?: string
      ) => Promise<void>
      chatCancel: () => Promise<void>
      onChatToken: (cb: (token: string) => void) => () => void
      onChatRouted: (cb: (r: ChatRouted) => void) => () => void
      onChatDone: (cb: (result: ChatResult) => void) => () => void
      onChatError: (cb: (message: string) => void) => () => void
      chatSessionList: (
        folderPath: string
      ) => Promise<
        Array<{ id: string; createdAt: number; updatedAt: number; title: string; type?: 'chat' | 'podcast' }>
      >
      chatSessionLoad: (folderPath: string, sessionId: string) => Promise<ChatSession | null>
      chatSessionSave: (folderPath: string, session: ChatSession) => Promise<void>
      chatSessionDelete: (folderPath: string, sessionId: string) => Promise<void>

      setWindowSize: (width: number, height: number) => Promise<void>

      generateRun: (
        folderPath: string,
        modelId: string,
        task: GenerateTask,
        format: GenerateFormat,
        selectedFiles?: string[]
      ) => Promise<void>
      generateCancel: () => Promise<void>
      onGenerateProgress: (cb: (p: GenerateProgress) => void) => () => void
      onGenerateToken: (cb: (token: string) => void) => () => void
      onGenerateDone: (cb: (result: string) => void) => () => void
      onGenerateError: (cb: (message: string) => void) => () => void

      podcastCancel: (sessionId: string) => Promise<void>
      audioRead: (folderPath: string, relFile: string) => Promise<Uint8Array>
      onPodcastProgress: (cb: (p: PodcastProgress) => void) => () => void
      onPodcastDone: (cb: (p: PodcastDone) => void) => () => void
      onPodcastError: (cb: (p: PodcastError) => void) => () => void
    }
  }
}
