import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
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
import { runAgent } from './services/agent/orchestrator'
import { buildDefaultRegistry } from './services/agent/tools'
import type { AgentStepEvent } from './services/agent/types'
import { PARSER_VERSION } from './services/chunker'
import { generateFromCorpus, type GenerateTask, type GenerateFormat } from './services/generate'
import { routeQuery } from './services/router'
import { getLangfuse } from './services/telemetry'
import { checkForUpdate, downloadAndInstall } from './services/updater'
import { rerankerGgufService } from './services/reranker-gguf'
import { folderWatcher } from './services/watcher'
import { ttsService, CancelledError, type MessageAudio } from './services/tts'
import { parsePodcastScript } from './services/podcast-script'
import { readFile, copyFile } from 'fs/promises'
import { resolve as resolvePath } from 'path'

// The agent's toolbox — built once; tools are stateless (per-run state lives
// in the AgentContext the orchestrator creates).
const agentRegistry = buildDefaultRegistry()

// Last-resort crash guard: without this, an uncaught main-process error kills
// the app silently and a tester can only report "it just closed". Log every
// error to userData; interrupt the user with a dialog only once per run.
let crashDialogShown = false
process.on('uncaughtException', (err) => {
  try {
    const logPath = join(app.getPath('userData'), 'crash.log')
    appendFileSync(logPath, `[${new Date().toISOString()}] ${err.stack ?? String(err)}\n`)
    if (!crashDialogShown) {
      crashDialogShown = true
      dialog.showErrorBox(
        'Vidura hit an unexpected error',
        `${err.message}\n\nDetails were saved to:\n${logPath}\n\nPlease report this at github.com/sgrpanchal31/vidura/issues`
      )
    }
  } catch {
    // never throw from the crash handler
  }
})

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

type PodcastVoices = { hostA: string; hostB: string; solo: string }

type Prefs = {
  lastFolder: string | null
  modelId: string | null
  rerankerEnabled: boolean
  ttsEngine: string | null
  podcastVoices: PodcastVoices | null
  // Escape hatch: false routes chat through the old router+RAG pipeline
  // instead of the agent loop. Kept for one release as a safety valve.
  agentEnabled?: boolean
}

function readPrefs(): Prefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))
    }
  } catch {
    // corrupted prefs — start fresh
  }
  return { lastFolder: null, modelId: null, rerankerEnabled: false, ttsEngine: null, podcastVoices: null }
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

// ── App version + updates ─────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('update:check', () => checkForUpdate())

ipcMain.handle('update:install', async (_event, url: string) => {
  await downloadAndInstall(url, (loaded, total) => {
    mainWindow?.webContents.send('update:progress', { loaded, total })
  })
})

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
    selectedFiles?: string[], // relative paths; undefined = all files
    sessionId?: string // needed for podcast audio file naming; optional for older callers
  ) => {
    // Returns immediately; streams tokens via 'chat:token', terminates with 'chat:done' or 'chat:error'
    const onToken = (token: string) => mainWindow?.webContents.send('chat:token', token)
    const onChatProgress = (p: unknown) => mainWindow?.webContents.send('chat:progress', p)

    // Create a top-level Langfuse trace for this chat:ask call.
    const lf = getLangfuse()
    const trace = lf?.trace({ name: 'chat-ask', input: { question } })
    const flushTrace = () => lf?.flushAsync().catch(() => {})

    // ── Agent path (the default) ─────────────────────────────────────────────
    // One loop replaces the router + hardcoded pipelines: the model itself
    // picks search/read steps (streamed to the UI via chat:step) and either
    // answers or researches + renders a deliverable (podcast/overview). Only
    // TTS happens out here — everything else lives in the loop, so the step
    // trail and the Langfuse trace cover the whole run.
    if (readPrefs().agentEnabled ?? true) {
      const onStep = (e: AgentStepEvent): void => {
        // The renderer suppresses raw script streaming and switches labels the
        // moment a deliverable is coming — tell it as soon as the loop decides.
        if (e.type === 'step_start' && (e.tool === 'generate_podcast' || e.tool === 'generate_overview')) {
          mainWindow?.webContents.send('chat:routed', {
            task: e.tool === 'generate_podcast' ? 'podcast' : 'overview',
          })
        }
        mainWindow?.webContents.send('chat:step', e)
      }

      const runAgentPath = async (): Promise<void> => {
        // File list for resolving the fuzzy names a model puts in deliverable
        // params, honoring the user's selection.
        await vectorStore.open(folderPath, { dim: embedDim(DEFAULT_EMBED) })
        let availableFiles = await vectorStore.listSourceFiles()
        if (selectedFiles) availableFiles = availableFiles.filter((f) => selectedFiles.includes(f))

        // Explicit /podcast command: no reason to spend an agent step deciding
        // what the user already said — preset the deliverable, keep the
        // research phase. Same narrator-count regex the old router used.
        let preset: { tool: string; params: Record<string, unknown> } | undefined
        let agentQuestion = question
        if (question.trimStart().startsWith('/podcast')) {
          const podcastMode = /\bnarrat|\b(solo|single|one)\b.{0,20}\b(narrator|voice|host|person)\b/i.test(question)
            ? 'solo'
            : 'duo'
          preset = { tool: 'generate_podcast', params: { files: [], mode: podcastMode } }
          agentQuestion =
            question.trimStart().replace(/^\/podcast\s*/i, '') || 'An engaging podcast about these documents'
          mainWindow?.webContents.send('chat:routed', { task: 'podcast' })
        } else {
          mainWindow?.webContents.send('chat:routed', { task: 'chat' })
        }

        const result = await runAgent({
          question: agentQuestion,
          folderPath,
          modelId,
          history,
          registry: agentRegistry,
          allowedFiles: selectedFiles,
          availableFiles,
          preset,
          onToken,
          onStep,
          externalTrace: trace,
        })
        if (result.deliverable?.tool === 'generate_podcast' && sessionId) {
          // The rendered script is result.answer; only audio remains.
          const messageId = `${Date.now()}-a`
          mainWindow?.webContents.send('chat:done', {
            answer: result.answer,
            citations: [],
            steps: result.steps,
            podcast: { sessionId, messageId },
          })
          startPodcastAudio(folderPath, sessionId, messageId, result.answer, trace)
        } else {
          mainWindow?.webContents.send('chat:done', {
            answer: result.answer,
            citations: result.citations,
            steps: result.steps,
          })
        }
        flushTrace()
      }

      runAgentPath().catch((err) => {
        mainWindow?.webContents.send('chat:error', String(err))
        flushTrace()
      })
      return
    }

    // ── Legacy pipeline (escape hatch: prefs.agentEnabled = false) ───────────
    const dim = embedDim(DEFAULT_EMBED)
    await vectorStore.open(folderPath, { dim })
    const availableFiles = await vectorStore.listSourceFiles()
    const decision = await routeQuery(question, availableFiles, trace)

    // Surface the routing decision on the trace so it's visible at the top level
    trace?.update({
      output: {
        scope: decision.scope,
        task: decision.task,
        targetFiles: decision.targetFiles,
        podcastMode: decision.podcastMode,
      },
    })

    // If the router named specific files but any are deselected by the user, filter them out
    if (decision.scope === 'file' && selectedFiles && decision.targetFiles.length > 0) {
      decision.targetFiles = decision.targetFiles.filter((f) => selectedFiles.includes(f))
      if (decision.targetFiles.length === 0) decision.scope = 'rag'
    }

    // corpus/chat is a router mistake — map-reduce makes no sense for a Q&A question
    if (decision.scope === 'corpus' && decision.task === 'chat') {
      decision.scope = 'rag'
    }

    // Let the renderer adapt its progress UI to the task (podcasts hide the
    // streaming transcript and show phase labels instead)
    mainWindow?.webContents.send('chat:routed', { task: decision.task })

    // Podcast tasks continue into TTS after the script is done; the renderer needs
    // the message id main will use so it can attach the audio when podcast:done fires
    const finishAnswer = (answer: string, citations: unknown[]) => {
      if (decision.task === 'podcast' && sessionId) {
        const messageId = `${Date.now()}-a`
        mainWindow?.webContents.send('chat:done', { answer, citations, podcast: { sessionId, messageId } })
        startPodcastAudio(folderPath, sessionId, messageId, answer, trace)
      } else {
        mainWindow?.webContents.send('chat:done', { answer, citations })
      }
      flushTrace()
    }

    if (decision.scope === 'file' && decision.task === 'chat') {
      if (decision.targetFiles.length === 1) {
        // Q&A about a single named file
        ragSummarizeFile(
          question,
          decision.targetFiles[0],
          folderPath,
          modelId,
          history,
          onToken,
          onChatProgress,
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
      } else {
        // Q&A about multiple named files — RAG with file filter
        ragQuery(
          question,
          folderPath,
          modelId,
          history,
          onToken,
          onChatProgress,
          decision.targetFiles.length > 0 ? decision.targetFiles : selectedFiles,
          undefined,
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
    } else if (decision.scope === 'file') {
      // Podcast or overview about one or more named files — map-reduce over just those files
      generateFromCorpus(
        folderPath,
        modelId,
        decision.task as GenerateTask,
        'prose',
        onToken,
        (p) => mainWindow?.webContents.send('generate:progress', p),
        decision.targetFiles,
        trace,
        question,
        decision.podcastMode
      )
        .then((answer) => finishAnswer(answer, []))
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
        trace,
        question,
        decision.podcastMode
      )
        .then((answer) => finishAnswer(answer, []))
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
        trace,
        decision.podcastMode
      )
        .then((result) => finishAnswer(result.answer, result.citations))
        .catch((err) => {
          mainWindow?.webContents.send('chat:error', String(err))
          flushTrace()
        })
    }
  }
)

// Fire-and-forget: renders the finished podcast script to a WAV in the notebook's
// .openbook/audio dir. Always emits a terminal event (done or error) so the
// renderer can clear its generating state.
function startPodcastAudio(
  folderPath: string,
  sessionId: string,
  messageId: string,
  script: string,
  trace?: { span(opts: { name: string; input?: unknown }): { end(opts?: { output?: unknown }): void } } | null
): void {
  // The chat-ask trace was already flushed when the script finished, but Langfuse
  // trace objects stay usable — this span attaches the audio phase to the same trace.
  const parsed = parsePodcastScript(script)
  const voices = readPrefs().podcastVoices ?? undefined
  const span = trace?.span({
    name: 'tts',
    input: {
      segments: parsed.segments.length,
      chapters: parsed.chapters.map((c) => c.title),
      solo: parsed.segments.every((s) => s.speaker === 'solo'),
      voices: voices ?? 'defaults',
    },
  })
  const flush = () =>
    getLangfuse()
      ?.flushAsync()
      .catch(() => {})
  ttsService
    .synthesizePodcast({
      script,
      folderPath,
      sessionId,
      messageId,
      voices,
      onProgress: (p) => mainWindow?.webContents.send('podcast:progress', { sessionId, messageId, ...p }),
    })
    .then((audio: MessageAudio) => {
      span?.end({ output: { durationSec: audio.durationSec, file: audio.file } })
      flush()
      mainWindow?.webContents.send('podcast:done', { sessionId, messageId, audio })
    })
    .catch((err) => {
      const cancelled = err instanceof CancelledError
      span?.end({ output: { error: cancelled ? 'cancelled' : String(err) } })
      flush()
      mainWindow?.webContents.send('podcast:error', {
        sessionId,
        messageId,
        cancelled,
        error: cancelled ? '' : String(err),
      })
    })
}

ipcMain.handle('podcast:cancel', (_event, sessionId: string) => {
  ttsService.cancel(sessionId)
})

ipcMain.handle('audio:read', async (_event, folderPath: string, relFile: string) => {
  const audioDir = join(folderPath, '.openbook', 'audio')
  const abs = resolvePath(folderPath, relFile)
  if (!abs.startsWith(audioDir + '/')) throw new Error('Invalid audio path')
  return readFile(abs)
})

// Copy a generated episode to a user-chosen location. Returns the saved path,
// or null if the user cancelled the dialog.
ipcMain.handle('audio:saveAs', async (_event, folderPath: string, relFile: string) => {
  const audioDir = join(folderPath, '.openbook', 'audio')
  const abs = resolvePath(folderPath, relFile)
  if (!abs.startsWith(audioDir + '/')) throw new Error('Invalid audio path')
  const date = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `podcast-${date}.wav`,
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  })
  if (result.canceled || !result.filePath) return null
  await copyFile(abs, result.filePath)
  return result.filePath
})

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
  ttsService.stop()
  llamaService.dispose()
  // Deliver any queued Langfuse events; fire-and-forget flushes lose them on fast quits
  getLangfuse()
    ?.shutdownAsync()
    .catch(() => {})
})
