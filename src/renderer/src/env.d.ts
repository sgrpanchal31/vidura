/// <reference types="vite/client" />

import type { Prefs, SystemInfo } from '../../preload/index'

declare global {
  interface Window {
    api: {
      pickFolder: () => Promise<string | null>
      getPrefs: () => Promise<Prefs>
      setPrefs: (patch: Partial<Prefs>) => Promise<void>
      getSystemInfo: () => Promise<SystemInfo>
    }
  }
}
