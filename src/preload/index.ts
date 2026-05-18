import { contextBridge, ipcRenderer } from 'electron'

export type Prefs = {
  lastFolder: string | null
  modelId: string | null
}

export type SystemInfo = {
  totalRamGB: number
  platform: NodeJS.Platform
}

const api = {
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickFolder'),
  getPrefs: (): Promise<Prefs> =>
    ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch: Partial<Prefs>): Promise<void> =>
    ipcRenderer.invoke('prefs:set', patch),
  getSystemInfo: (): Promise<SystemInfo> =>
    ipcRenderer.invoke('system:info')
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
