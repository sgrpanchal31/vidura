import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import os from 'os'

const PREFS_PATH = join(app.getPath('userData'), 'prefs.json')

type Prefs = {
  lastFolder: string | null
  modelId: string | null
}

function readPrefs(): Prefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))
    }
  } catch {
    // corrupted prefs — start fresh
  }
  return { lastFolder: null, modelId: null }
}

function writePrefs(prefs: Prefs): void {
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf-8')
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#272320',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    ...(isMac && { trafficLightPosition: { x: 16, y: 16 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const isDev = process.env['ELECTRON_RENDERER_URL'] !== undefined
  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})

ipcMain.handle('prefs:get', () => readPrefs())

ipcMain.handle('prefs:set', (_event, patch: Partial<Prefs>) => {
  writePrefs({ ...readPrefs(), ...patch })
})

ipcMain.handle('system:info', () => ({
  totalRamGB: Math.round(os.totalmem() / 1024 ** 3),
  platform: process.platform
}))

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
