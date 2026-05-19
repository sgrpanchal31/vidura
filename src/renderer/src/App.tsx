import { useState, useEffect, useRef } from 'react'
import Onboarding from './screens/Onboarding'
import Chat from './screens/Chat'
import './styles/globals.css'
import type { IndexProgress, IndexSummary, ModelProgress } from '../../preload'

type Screen = 'loading' | 'onboarding' | 'indexing' | 'model_prep' | 'ready'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [notebookFolder, setNotebookFolder] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)

  // Indexing
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [summary, setSummary] = useState<IndexSummary | null>(null)
  const [ingestError, setIngestError] = useState<string | null>(null)

  // Model prep
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null)
  const [modelLoadStage, setModelLoadStage] = useState<'download' | 'load' | null>(null)
  const [modelPrepError, setModelPrepError] = useState<string | null>(null)

  const unsubsRef = useRef<Array<() => void>>([])

  useEffect(() => {
    window.api.getPrefs().then((prefs) => {
      if (prefs.lastFolder && prefs.modelId) {
        // Returning user — skip onboarding and indexing, just load the model
        setNotebookFolder(prefs.lastFolder)
        setModelId(prefs.modelId)
        startModelPrep(prefs.modelId)
      } else {
        setScreen('onboarding')
      }
    })
  }, [])

  async function handleOnboardingComplete(folder: string, mId: string) {
    window.api.setPrefs({ lastFolder: folder, modelId: mId })
    setNotebookFolder(folder)
    setModelId(mId)
    setScreen('indexing')
    setProgress(null)
    setSummary(null)
    setIngestError(null)

    const unsub = window.api.onIngestProgress(p => setProgress(p))
    try {
      const result = await window.api.startIngest(folder)
      setSummary(result)
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err))
    } finally {
      unsub()
    }

    startModelPrep(mId)
  }

  async function startModelPrep(mId: string) {
    setScreen('model_prep')
    setModelPrepError(null)
    setModelProgress(null)
    setModelLoadStage(null)

    try {
      const alreadyDownloaded = await window.api.modelIsDownloaded(mId)

      if (!alreadyDownloaded) {
        setModelLoadStage('download')
        const unsub = window.api.onModelProgress(p => setModelProgress(p))
        unsubsRef.current.push(unsub)
        try {
          await window.api.modelDownload(mId)
        } finally {
          unsub()
          unsubsRef.current = unsubsRef.current.filter(u => u !== unsub)
        }
      }

      setModelLoadStage('load')
      await window.api.modelLoad(mId)

      // Resize window for the three-pane chat layout before showing it
      window.api.setWindowSize(1100, 760)
      setScreen('ready')
    } catch (err) {
      setModelPrepError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── Screens ───────────────────────────────────────────────────────────────

  if (screen === 'loading') return null

  if (screen === 'onboarding') {
    return (
      <div className="app-window">
        <Onboarding onComplete={handleOnboardingComplete} />
      </div>
    )
  }

  if (screen === 'indexing') {
    const pct =
      progress?.total > 0 &&
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
        <div style={{ padding: '64px 52px' }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontStyle: 'italic', fontSize: '18px', color: 'var(--ink)', display: 'block', marginBottom: '20px' }}>
            Indexing your sources
          </span>
          <div style={{ fontSize: '12px', color: 'var(--slate)', marginBottom: '12px', fontFamily: "'IBM Plex Sans', sans-serif" }}>
            {label}
          </div>
          <div style={{ height: '2px', background: 'var(--line-m)', borderRadius: '1px', overflow: 'hidden', width: '280px' }}>
            <div style={{
              height: '100%',
              background: 'var(--ox)',
              width: pct !== null ? `${pct}%` : '0%',
              transition: 'width 0.2s ease'
            }} />
          </div>
          {ingestError && (
            <div style={{ marginTop: '16px', fontSize: '12px', color: '#a03030', fontFamily: "'IBM Plex Sans', sans-serif" }}>
              {ingestError}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (screen === 'model_prep') {
    const pct = modelProgress && modelProgress.total > 0
      ? Math.round((modelProgress.downloaded / modelProgress.total) * 100)
      : null

    const label = modelLoadStage === 'load'
      ? 'Loading model into memory…'
      : modelProgress
        ? `Downloading model — ${pct ?? 0}%`
        : 'Checking model…'

    return (
      <div className="app-window">
        <div style={{ padding: '64px 52px' }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontStyle: 'italic', fontSize: '18px', color: 'var(--ink)', display: 'block', marginBottom: '20px' }}>
            {modelLoadStage === 'load' ? 'Loading model' : 'Downloading model'}
          </span>
          {modelPrepError ? (
            <div>
              <div style={{ color: '#a03030', fontSize: '12px', fontFamily: "'IBM Plex Sans', sans-serif", marginBottom: '16px' }}>
                {modelPrepError}
              </div>
              <button
                onClick={() => modelId && startModelPrep(modelId)}
                style={{ padding: '7px 14px', borderRadius: '3px', border: 'none', background: 'var(--ox)', color: '#F9F0E6', fontSize: '12px', cursor: 'pointer', fontFamily: "'IBM Plex Sans', sans-serif" }}
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontSize: '12px', color: 'var(--slate)', marginBottom: '12px', fontFamily: "'IBM Plex Sans', sans-serif" }}>
                {label}
              </div>
              {modelLoadStage === 'download' && (
                <div style={{ height: '2px', background: 'var(--line-m)', borderRadius: '1px', overflow: 'hidden', width: '280px' }}>
                  <div style={{
                    height: '100%',
                    background: 'var(--ox)',
                    width: pct !== null ? `${pct}%` : '0%',
                    transition: 'width 0.3s ease'
                  }} />
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
        <Chat folder={notebookFolder} modelId={modelId} />
      </div>
    )
  }

  return null
}
