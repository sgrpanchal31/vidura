/// <reference types="vite/client" />

import type { Prefs, SystemInfo, IndexProgress, IndexSummary } from '../../preload/index'

declare global {
  interface Window {
    api: {
      pickFolder: () => Promise<string | null>
      getPrefs: () => Promise<Prefs>
      setPrefs: (patch: Partial<Prefs>) => Promise<void>
      getSystemInfo: () => Promise<SystemInfo>
      startIngest: (folderPath: string) => Promise<IndexSummary>
      getIngestState: (folderPath: string) => Promise<unknown>
      onIngestProgress: (cb: (p: IndexProgress) => void) => () => void
    }
  }
}
