import { useState, useEffect, useRef } from 'react'
import Onboarding from './screens/Onboarding'
import Chat from './screens/Chat'
import Settings from './screens/Settings'
import './styles/globals.css'
import type { IndexProgress, IndexSummary, ModelProgress } from '../../preload'

type Screen = 'loading' | 'onboarding' | 'indexing' | 'model_prep' | 'ready' | 'settings'

// Must match DEFAULT_EMBED in embed-models.ts
const DEFAULT_EMBED_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [notebookFolder, setNotebookFolder] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)

  // Indexing
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- state set on ingest completion, reserved for a future "N files indexed" indicator
  const [summary, setSummary] = useState<IndexSummary | null>(null)
  const [ingestError, setIngestError] = useState<string | null>(null)

  // Model prep
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null)
  const [modelLoadStage, setModelLoadStage] = useState<'download' | 'load' | 'embed' | null>(null)
  const [modelPrepError, setModelPrepError] = useState<string | null>(null)

  const unsubsRef = useRef<Array<() => void>>([])

  useEffect(() => {
    window.api.getPrefs().then((prefs) => {
      if (prefs.lastFolder && prefs.modelId) {
        setNotebookFolder(prefs.lastFolder)
        setModelId(prefs.modelId)
        startModelPrep(prefs.modelId, prefs.lastFolder)
      } else {
        setScreen('onboarding')
      }
    })
  }, [])

  // ── Ingest helper ──────────────────────────────────────────────────────────

  async function runIngest(folder: string, embedModel?: string): Promise<boolean> {
    setScreen('indexing')
    setProgress(null)
    setSummary(null)
    setIngestError(null)

    const unsub = window.api.onIngestProgress((p) => setProgress(p))
    try {
      const result = await window.api.startIngest(folder, embedModel)
      setSummary(result)
      return true
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      unsub()
    }
  }

  // ── Embed + index check ────────────────────────────────────────────────────
  // After LLM is ready, verify the embed model is downloaded and the folder
  // has indexed files. If either is missing, run ingest (which downloads the
  // embed model and indexes files). On success, show chat.

  async function ensureEmbedAndIndex(folder: string) {
    // Always run ingest — indexFolder is incremental (hash-based) so unchanged files
    // are skipped. This ensures new/deleted files are picked up on every launch and
    // the file watcher is started reliably.
    const ok = await runIngest(folder, DEFAULT_EMBED_ID)
    if (ok) {
      window.api.setWindowSize(1100, 760)
      setScreen('ready')
    }
    // On failure: stay on indexing screen showing the error + Back button
  }

  // ── LLM prep ──────────────────────────────────────────────────────────────

  async function startModelPrep(mId: string, folder?: string) {
    setScreen('model_prep')
    setModelPrepError(null)
    setModelProgress(null)
    setModelLoadStage(null)

    try {
      const alreadyDownloaded = await window.api.modelIsDownloaded(mId)

      if (!alreadyDownloaded) {
        setModelLoadStage('download')
        const unsub = window.api.onModelProgress((p) => setModelProgress(p))
        unsubsRef.current.push(unsub)
        try {
          await window.api.modelDownload(mId)
        } finally {
          unsub()
          unsubsRef.current = unsubsRef.current.filter((u) => u !== unsub)
        }
      }

      setModelLoadStage('load')
      await window.api.modelLoad(mId)

      // Ensure embedding model is downloaded before opening chat.
      const [embedInfo] = await window.api.listEmbedModels()
      if (!embedInfo?.downloaded) {
        setModelLoadStage('embed')
        const unsub = window.api.onEmbedDownloadProgress((p) => {
          setModelProgress({ modelId: p.hfId, downloaded: p.loaded, total: p.total })
        })
        unsubsRef.current.push(unsub)
        try {
          await window.api.embedEnsure()
        } finally {
          unsub()
          unsubsRef.current = unsubsRef.current.filter((u) => u !== unsub)
          setModelProgress(null)
        }
      }
    } catch (err) {
      setModelPrepError(err instanceof Error ? err.message : String(err))
      return
    }

    // LLM + embed model are ready. Check indexing.
    if (folder) {
      await ensureEmbedAndIndex(folder)
    } else {
      window.api.setWindowSize(1100, 760)
      setScreen('ready')
    }
  }

  // ── Screen handlers ────────────────────────────────────────────────────────

  async function handleOnboardingComplete(folder: string, mId: string) {
    window.api.setPrefs({ lastFolder: folder, modelId: mId })
    setNotebookFolder(folder)
    setModelId(mId)
    startModelPrep(mId, folder)
  }

  // Called from the blocked-folder recovery screen. Re-picking via the native
  // dialog grants macOS access (Powerbox) even for the same folder path.
  async function recoverFolderAccess() {
    const folder = await window.api.pickFolder()
    if (!folder) return
    window.api.setPrefs({ lastFolder: folder })
    setNotebookFolder(folder)
    const ok = await runIngest(folder, DEFAULT_EMBED_ID)
    if (ok) {
      window.api.setWindowSize(1100, 760)
      setScreen('ready')
    }
  }

  async function handleChangeFolder() {
    const newFolder = await window.api.pickFolder()
    if (!newFolder || newFolder === notebookFolder) return

    await window.api.chatCancel()
    window.api.setPrefs({ lastFolder: newFolder })
    setNotebookFolder(newFolder)

    const ok = await runIngest(newFolder)
    if (ok) {
      window.api.setWindowSize(1100, 760)
      setScreen('ready')
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  if (screen === 'loading') return null

  if (screen === 'onboarding') {
    return (
      <div className="app-window">
        <div className="screen-content">
          <Onboarding onComplete={handleOnboardingComplete} />
        </div>
      </div>
    )
  }

  if (screen === 'indexing') {
    const pct =
      progress !== null &&
      progress.total > 0 &&
      (progress.stage === 'parsing' || progress.stage === 'embedding' || progress.stage === 'model_load')
        ? Math.round((progress.processed / progress.total) * 100)
        : null

    const label = !progress
      ? 'Preparing…'
      : progress.stage === 'scanning'
        ? 'Scanning folder…'
        : progress.stage === 'hashing'
          ? `Checking ${progress.total} file${progress.total !== 1 ? 's' : ''}…`
          : progress.stage === 'parsing' && progress.total > 0
            ? `Parsing ${progress.processed + 1} of ${progress.total}${progress.currentFile ? ` — ${progress.currentFile.split('/').pop()}` : ''}`
            : progress.stage === 'parsing'
              ? 'All files up to date'
              : progress.stage === 'model_load' && progress.total > 0
                ? `Downloading embedding model — ${Math.round((progress.processed / progress.total) * 100)}%`
                : progress.stage === 'model_load'
                  ? 'Loading embedding model…'
                  : progress.stage === 'embedding' && progress.total > 0
                    ? `Embedding ${progress.processed} of ${progress.total} chunks…`
                    : progress.stage === 'embedding'
                      ? 'Building embeddings…'
                      : 'Finishing up…'

    return (
      <div className="app-window">
        <div className="screen-content" style={{ padding: '64px 52px' }}>
          <span
            style={{
              fontFamily: "'Source Serif 4', serif",
              fontStyle: 'italic',
              fontSize: '18px',
              color: 'var(--ink)',
              display: 'block',
              marginBottom: '20px',
            }}
          >
            Indexing your sources
          </span>
          <div
            style={{
              fontSize: '12px',
              color: 'var(--slate)',
              marginBottom: '12px',
              fontFamily: "'IBM Plex Sans', sans-serif",
            }}
          >
            {label}
          </div>
          <div
            style={{
              height: '2px',
              background: 'var(--line-m)',
              borderRadius: '1px',
              overflow: 'hidden',
              width: '280px',
            }}
          >
            <div
              style={{
                height: '100%',
                background: 'var(--ox)',
                width: pct !== null ? `${pct}%` : '0%',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
          {ingestError && (
            <div style={{ marginTop: '16px', fontFamily: "'IBM Plex Sans', sans-serif" }}>
              {ingestError.includes('FOLDER_UNREADABLE') ? (
                <>
                  <div style={{ fontSize: '12px', color: '#a03030', marginBottom: '12px' }}>
                    <strong>Can't open this folder.</strong> macOS is blocking access to it — this happens when the app
                    is launched from a terminal without folder permissions. Choose the folder again to grant access, or
                    relaunch from a terminal with Full Disk Access (e.g. iTerm).
                  </div>
                  <button
                    onClick={recoverFolderAccess}
                    style={{
                      padding: '7px 14px',
                      borderRadius: '3px',
                      border: 'none',
                      background: 'var(--ox)',
                      color: '#F9F0E6',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    Choose folder
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '12px', color: '#a03030', marginBottom: '12px' }}>{ingestError}</div>
                  {notebookFolder && modelId && (
                    <button
                      onClick={() => notebookFolder && modelId && startModelPrep(modelId, notebookFolder)}
                      style={{
                        padding: '7px 14px',
                        borderRadius: '3px',
                        border: 'none',
                        background: 'var(--ox)',
                        color: '#F9F0E6',
                        fontSize: '12px',
                        cursor: 'pointer',
                        marginRight: '8px',
                      }}
                    >
                      Retry
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (screen === 'model_prep') {
    const pct =
      modelProgress && modelProgress.total > 0
        ? Math.round((modelProgress.downloaded / modelProgress.total) * 100)
        : null

    const label =
      modelLoadStage === 'load'
        ? 'Loading model into memory…'
        : modelLoadStage === 'embed'
          ? modelProgress
            ? `Downloading embedding model — ${pct ?? 0}%`
            : 'Downloading embedding model…'
          : modelProgress
            ? `Downloading model — ${pct ?? 0}%`
            : 'Checking model…'

    const heading =
      modelLoadStage === 'load'
        ? 'Loading model'
        : modelLoadStage === 'embed'
          ? 'Downloading embedding model'
          : 'Downloading model'

    return (
      <div className="app-window">
        <div className="screen-content" style={{ padding: '64px 52px' }}>
          <span
            style={{
              fontFamily: "'Source Serif 4', serif",
              fontStyle: 'italic',
              fontSize: '18px',
              color: 'var(--ink)',
              display: 'block',
              marginBottom: '20px',
            }}
          >
            {heading}
          </span>
          {modelPrepError ? (
            <div>
              <div
                style={{
                  color: '#a03030',
                  fontSize: '12px',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  marginBottom: '16px',
                }}
              >
                {modelPrepError}
              </div>
              <button
                onClick={() => modelId && startModelPrep(modelId, notebookFolder ?? undefined)}
                style={{
                  padding: '7px 14px',
                  borderRadius: '3px',
                  border: 'none',
                  background: 'var(--ox)',
                  color: '#F9F0E6',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                }}
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--slate)',
                  marginBottom: '12px',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                }}
              >
                {label}
              </div>
              {(modelLoadStage === 'download' || modelLoadStage === 'embed') && (
                <div
                  style={{
                    height: '2px',
                    background: 'var(--line-m)',
                    borderRadius: '1px',
                    overflow: 'hidden',
                    width: '280px',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      background: 'var(--ox)',
                      width: pct !== null ? `${pct}%` : '0%',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  if (screen === 'ready' && notebookFolder && modelId) {
    return (
      <div className="app-window">
        <div className="screen-content">
          <Chat
            key={notebookFolder}
            folder={notebookFolder}
            modelId={modelId}
            onChangeFolder={handleChangeFolder}
            onOpenSettings={() => setScreen('settings')}
          />
        </div>
      </div>
    )
  }

  if (screen === 'settings' && notebookFolder && modelId) {
    return (
      <div className="app-window">
        <div className="screen-content">
          <Settings
            folder={notebookFolder}
            modelId={modelId}
            onClose={() => setScreen('ready')}
            onModelChanged={(id) => setModelId(id)}
          />
        </div>
      </div>
    )
  }

  return null
}
