import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import os from 'os'
import { indexFolder } from './services/indexer'
import {
  readState,
  listChatSessions,
  loadChatSession,
  saveChatSession,
  deleteChatSession,
  type ChatSession,
} from './services/state'
import { embedService } from './services/embed'
import { vectorStore } from './services/store'
import { isModelDownloaded, downloadModel, cancelDownload, listModels, deleteModel } from './services/models'
import { listEmbedModels, deleteEmbed, DEFAULT_EMBED, embedDim } from './services/embed-models'
import { llamaService } from './services/inference'
import { ragQuery, ragSummarizeFile } from './services/rag'
import { PARSER_VERSION } from './services/chunker'
import { generateFromCorpus, type GenerateTask, type GenerateFormat } from './services/generate'
import { routeQuery } from './services/router'
import { getLangfuse } from './services/telemetry'
import { rerankerGgufService } from './services/reranker-gguf'
import { folderWatcher } from './services/watcher'

let isBackgroundIndexing = false

async function runBackgroundIndex(folderPath: string, embeddingModel?: string): Promise<void> {
  if (isBackgroundIndexing) return
  isBackgroundIndexing = true
  mainWindow?.webContents.send('watch:status', { active: true })
  try {
    await indexFolder(
      folderPath,
      (progress) => mainWindow?.webContents.send('ingest:progress', progress),
      embeddingModel
    )
  } finally {
    isBackgroundIndexing = false
    mainWindow?.webContents.send('watch:status', { active: false })
  }
}

const PREFS_PATH = join(app.getPath('userData'), 'prefs.json')

type Prefs = {
  lastFolder: string | null
  modelId: string | null
  rerankerEnabled: boolean
}

function readPrefs(): Prefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))
    }
  } catch {
    // corrupted prefs — start fresh
  }
  return { lastFolder: null, modelId: null, rerankerEnabled: false }
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
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#272320',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    ...(isMac && { trafficLightPosition: { x: 16, y: 16 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
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
    properties: ['openDirectory'],
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
  platform: process.platform,
}))

ipcMain.handle('ingest:parserVersion', () => PARSER_VERSION)

ipcMain.handle('ingest:start', async (_event, folderPath: string, embeddingModel?: string) => {
  const result = await indexFolder(
    folderPath,
    (progress) => {
      mainWindow?.webContents.send('ingest:progress', progress)
    },
    embeddingModel
  )
  folderWatcher.start(folderPath, () => runBackgroundIndex(folderPath, embeddingModel))
  return result.summary
})

ipcMain.handle('ingest:getState', (_event, folderPath: string) => {
  return readState(folderPath)
})

ipcMain.handle('search:query', async (_event, query: string, topK?: number, folderPath?: string) => {
  // Lazily start embed service and open store if the user returns to the app
  // after a previous session where indexing already ran
  const folder = folderPath ?? readPrefs().lastFolder
  const embedModel = DEFAULT_EMBED
  const dim = embedDim(embedModel)
  await embedService.start(undefined, { modelId: embedModel })
  if (folder) await vectorStore.open(folder, { dim })
  const [queryVector] = await embedService.embedBatched([query])
  return vectorStore.search(queryVector, topK ?? 8)
})

// ── Model management ──────────────────────────────────────────────────────────

ipcMain.handle('model:isDownloaded', async (_event, modelId: string) => {
  return isModelDownloaded(modelId)
})

ipcMain.handle('model:download', async (_event, modelId: string) => {
  await downloadModel(modelId, (downloaded, total) => {
    mainWindow?.webContents.send('model:progress', { modelId, downloaded, total })
  })
})

ipcMain.handle('model:cancelDownload', () => {
  cancelDownload()
})

ipcMain.handle('model:load', async (_event, modelId: string) => {
  await llamaService.loadModel(modelId)
})

ipcMain.handle('model:unload', async () => {
  await llamaService.unloadModel()
})

ipcMain.handle('model:list', async () => {
  return listModels()
})

ipcMain.handle('model:delete', async (_event, modelId: string) => {
  // Unload first if this is the currently-loaded model
  if (llamaService.isLoaded(modelId)) {
    await llamaService.unloadModel()
  }
  await deleteModel(modelId)
})

ipcMain.handle('embed:list', async () => {
  return listEmbedModels()
})

// Ensure the default embedding model is downloaded and ready (used at startup).
ipcMain.handle('embed:ensure', async () => {
  await embedService.start(
    (loaded, total) => mainWindow?.webContents.send('embed:downloadProgress', { hfId: DEFAULT_EMBED, loaded, total }),
    { modelId: DEFAULT_EMBED }
  )
})

ipcMain.handle('embed:download', async (_event, hfId: string) => {
  await embedService.start(
    (loaded, total) => mainWindow?.webContents.send('embed:downloadProgress', { hfId, loaded, total }),
    { modelId: hfId }
  )
})

ipcMain.handle('embed:delete', async (_event, hfId: string) => {
  await deleteEmbed(hfId)
})

// ── Reranker ──────────────────────────────────────────────────────────────────

ipcMain.handle('reranker:getStatus', async () => ({
  enabled: readPrefs().rerankerEnabled ?? false,
  status: rerankerGgufService.getStatus(),
  downloaded: await isModelDownloaded('bge-reranker-v2-m3'),
}))

ipcMain.handle('reranker:setEnabled', async (_event, enabled: boolean) => {
  writePrefs({ ...readPrefs(), rerankerEnabled: enabled })
  if (enabled) {
    const downloaded = await isModelDownloaded('bge-reranker-v2-m3')
    if (!downloaded) throw new Error('Reranker model not downloaded — download it from Settings first')
    await rerankerGgufService.start()
  } else {
    rerankerGgufService.stop()
  }
})

// ── Chat / RAG ────────────────────────────────────────────────────────────────

ipcMain.handle(
  'chat:ask',
  async (
    _event,
    question: string,
    folderPath: string,
    modelId: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    selectedFiles?: string[] // relative paths; undefined = all files
  ) => {
    // Returns immediately; streams tokens via 'chat:token', terminates with 'chat:done' or 'chat:error'
    const onToken = (token: string) => mainWindow?.webContents.send('chat:token', token)
    const onChatProgress = (p: unknown) => mainWindow?.webContents.send('chat:progress', p)

    // Create a top-level Langfuse trace for this chat:ask call.
    // The route span (showing scope/task/targetFile/usedFallback) is attached inside routeQuery.
    const lf = getLangfuse()
    const trace = lf?.trace({ name: 'chat-ask', input: { question } })

    const dim = embedDim(DEFAULT_EMBED)
    await vectorStore.open(folderPath, { dim })
    const availableFiles = await vectorStore.listSourceFiles()
    const decision = await routeQuery(question, availableFiles, trace)

    // Surface the routing decision on the trace so it's visible at the top level
    trace?.update({ output: { scope: decision.scope, task: decision.task, targetFile: decision.targetFile } })

    // If the router picked a specific file that the user has deselected, drop to rag
    if (
      decision.scope === 'file' &&
      decision.targetFile &&
      selectedFiles &&
      !selectedFiles.includes(decision.targetFile)
    ) {
      decision.scope = 'rag'
      decision.targetFile = null
    }

    // corpus/chat is a router mistake — map-reduce makes no sense for a Q&A question
    if (decision.scope === 'corpus' && decision.task === 'chat') {
      decision.scope = 'rag'
    }

    // Flush the full trace (routing + pipeline spans) once the pipeline promise settles
    const flushTrace = () => lf?.flushAsync().catch(() => {})

    if (decision.scope === 'file' && decision.task === 'chat') {
      // Q&A about a specific named file
      ragSummarizeFile(question, decision.targetFile!, folderPath, modelId, history, onToken, onChatProgress, trace)
        .then((result) => {
          mainWindow?.webContents.send('chat:done', result)
          flushTrace()
        })
        .catch((err) => {
          mainWindow?.webContents.send('chat:error', String(err))
          flushTrace()
        })
    } else if (decision.scope === 'file') {
      // Podcast or overview about a single named file — map-reduce over just that file
      generateFromCorpus(
        folderPath,
        modelId,
        decision.task as GenerateTask,
        'prose',
        onToken,
        (p) => mainWindow?.webContents.send('generate:progress', p),
        [decision.targetFile!],
        trace
      )
        .then((answer) => {
          mainWindow?.webContents.send('chat:done', { answer, citations: [] })
          flushTrace()
        })
        .catch((err) => {
          mainWindow?.webContents.send('chat:error', String(err))
          flushTrace()
        })
    } else if (decision.scope === 'corpus') {
      // Map-reduce over all/selected files
      const task = decision.task === 'chat' ? 'overview' : decision.task
      generateFromCorpus(
        folderPath,
        modelId,
        task as GenerateTask,
        'prose',
        onToken,
        (p) => mainWindow?.webContents.send('generate:progress', p),
        selectedFiles,
        trace
      )
        .then((answer) => {
          mainWindow?.webContents.send('chat:done', { answer, citations: [] })
          flushTrace()
        })
        .catch((err) => {
          mainWindow?.webContents.send('chat:error', String(err))
          flushTrace()
        })
    } else {
      // RAG: targeted search, optionally with format synthesis (podcast/overview from retrieved chunks)
      ragQuery(
        question,
        folderPath,
        modelId,
        history,
        onToken,
        onChatProgress,
        selectedFiles,
        decision.task === 'chat' ? undefined : decision.task,
        trace
      )
        .then((result) => {
          mainWindow?.webContents.send('chat:done', result)
          flushTrace()
        })
        .catch((err) => {
          mainWindow?.webContents.send('chat:error', String(err))
          flushTrace()
        })
    }
  }
)

ipcMain.handle('chat:cancel', () => {
  llamaService.cancel()
})

ipcMain.handle('chat:session:list', async (_event, folderPath: string) => {
  return listChatSessions(folderPath)
})

ipcMain.handle('chat:session:load', async (_event, folderPath: string, sessionId: string) => {
  return loadChatSession(folderPath, sessionId)
})

ipcMain.handle('chat:session:save', async (_event, folderPath: string, session: ChatSession) => {
  await saveChatSession(folderPath, session)
})

ipcMain.handle('chat:session:delete', async (_event, folderPath: string, sessionId: string) => {
  await deleteChatSession(folderPath, sessionId)
})

// ── Generation (map-reduce over full corpus) ─────────────────────────────────

ipcMain.handle(
  'generate:run',
  async (
    _event,
    folderPath: string,
    modelId: string,
    task: GenerateTask,
    format: GenerateFormat,
    selectedFiles?: string[]
  ) => {
    // Returns immediately; streams tokens via 'generate:token', terminates with 'generate:done' or 'generate:error'
    generateFromCorpus(
      folderPath,
      modelId,
      task,
      format,
      (token) => mainWindow?.webContents.send('generate:token', token),
      (p) => mainWindow?.webContents.send('generate:progress', p),
      selectedFiles
    )
      .then((result) => mainWindow?.webContents.send('generate:done', result))
      .catch((err) => mainWindow?.webContents.send('generate:error', String(err)))
  }
)

ipcMain.handle('window:setSize', (_event, width: number, height: number) => {
  if (!mainWindow) return
  mainWindow.setSize(width, height, true)
  mainWindow.center()
})

app.whenReady().then(() => {
  createWindow()

  // Silently warm up reranker if enabled and model is already downloaded.
  if (readPrefs().rerankerEnabled ?? false) {
    isModelDownloaded('bge-reranker-v2-m3').then((downloaded) => {
      if (downloaded) rerankerGgufService.start().catch(() => {})
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    embedService.stop()
    rerankerGgufService.stop()
    app.quit()
  }
})

app.on('before-quit', () => {
  folderWatcher.stop()
  embedService.stop()
  rerankerGgufService.stop()
  llamaService.dispose()
})
