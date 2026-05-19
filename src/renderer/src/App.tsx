import { useState, useEffect, useRef } from 'react'
import Onboarding from './screens/Onboarding'
import './styles/globals.css'
import type { IndexProgress, IndexSummary, ModelProgress, ChatResult, CitationEntry } from '../../preload'

type Screen = 'loading' | 'onboarding' | 'indexing' | 'model_prep' | 'ready'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [notebookFolder, setNotebookFolder] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)

  // Indexing
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [summary, setSummary] = useState<IndexSummary | null>(null)
  const [ingestError, setIngestError] = useState<string | null>(null)

  // Model prep (download + load)
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null)
  const [modelLoadStage, setModelLoadStage] = useState<'download' | 'load' | null>(null)
  const [modelPrepError, setModelPrepError] = useState<string | null>(null)

  // Smoke-test chat
  const [testQuestion, setTestQuestion] = useState('')
  const [streamedTokens, setStreamedTokens] = useState('')
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const unsubsRef = useRef<Array<() => void>>([])

  useEffect(() => {
    window.api.getPrefs().then(() => {
      // TODO Day 11-12: if prefs.lastFolder && prefs.modelId, skip onboarding
      setScreen('onboarding')
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

    const unsub = window.api.onIngestProgress((p) => setProgress(p))
    try {
      const result = await window.api.startIngest(folder)
      setSummary(result)
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err))
    } finally {
      unsub()
    }

    // Move straight to model prep (download + load)
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
        const unsub = window.api.onModelProgress((p) => setModelProgress(p))
        try {
          await window.api.modelDownload(mId)
        } finally {
          unsub()
        }
      }

      setModelLoadStage('load')
      await window.api.modelLoad(mId)

      setScreen('ready')
    } catch (err) {
      setModelPrepError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleTestChat() {
    if (!testQuestion.trim() || !notebookFolder || !modelId || chatLoading) return

    // Clean up any previous subscriptions
    unsubsRef.current.forEach((u) => u())
    unsubsRef.current = []

    setChatLoading(true)
    setStreamedTokens('')
    setChatResult(null)
    setChatError(null)

    const unsubToken = window.api.onChatToken((tok) =>
      setStreamedTokens((prev) => prev + tok)
    )
    const unsubDone = window.api.onChatDone((result) => {
      setChatResult(result)
      setChatLoading(false)
      cleanup()
    })
    const unsubError = window.api.onChatError((msg) => {
      setChatError(msg)
      setChatLoading(false)
      cleanup()
    })

    function cleanup() {
      unsubToken()
      unsubDone()
      unsubError()
      unsubsRef.current = []
    }

    unsubsRef.current = [unsubToken, unsubDone, unsubError]

    await window.api.chatAsk(testQuestion.trim(), notebookFolder, modelId)
  }

  function handleCancelChat() {
    window.api.chatCancel()
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
    const displayText = streamedTokens || chatResult?.answer || ''
    const citations: CitationEntry[] = chatResult?.citations ?? []

    return (
      <div className="app-window">
        <div style={{ padding: '48px 52px', fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontStyle: 'italic', fontSize: '18px', color: 'var(--ink)', display: 'block', marginBottom: '6px' }}>
            Notebook ready
          </span>
          {summary && (
            <div style={{ fontSize: '11px', color: 'var(--slate)', marginBottom: '28px' }}>
              {summary.totalChunks} chunks indexed
              {ingestError && ` · error: ${ingestError}`}
            </div>
          )}

          {/* Smoke-test chat — replaced by full chat UI in Day 11–12 */}
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--slate)', marginBottom: '8px' }}>
              Test question
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                value={testQuestion}
                onChange={(e) => setTestQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleTestChat()}
                placeholder="Ask something about your sources…"
                disabled={chatLoading}
                style={{
                  flex: 1,
                  fontSize: '13px',
                  padding: '7px 10px',
                  border: '1px solid var(--line-m)',
                  borderRadius: '3px',
                  background: 'rgba(255,255,255,0.3)',
                  color: 'var(--ink)',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  outline: 'none',
                }}
              />
              {chatLoading ? (
                <button
                  onClick={handleCancelChat}
                  style={{ padding: '7px 14px', borderRadius: '3px', border: '1px solid var(--line-m)', background: 'transparent', color: 'var(--slate)', fontSize: '12px', cursor: 'pointer', fontFamily: "'IBM Plex Sans', sans-serif" }}
                >
                  Cancel
                </button>
              ) : (
                <button
                  onClick={handleTestChat}
                  disabled={!testQuestion.trim()}
                  style={{ padding: '7px 14px', borderRadius: '3px', border: 'none', background: 'var(--ox)', color: '#F9F0E6', fontSize: '12px', cursor: 'pointer', fontFamily: "'IBM Plex Sans', sans-serif', opacity: !testQuestion.trim() ? 0.5 : 1" }}
                >
                  Ask
                </button>
              )}
            </div>
          </div>

          {chatError && (
            <div style={{ fontSize: '12px', color: '#a03030', marginTop: '12px' }}>{chatError}</div>
          )}

          {displayText && (
            <div style={{ marginTop: '16px', fontSize: '13px', lineHeight: '1.7', color: 'var(--ink)', whiteSpace: 'pre-wrap', maxHeight: '260px', overflowY: 'auto', borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
              {displayText}
              {chatLoading && <span style={{ opacity: 0.4 }}>▋</span>}
            </div>
          )}

          {citations.length > 0 && (
            <div style={{ marginTop: '14px', borderTop: '1px solid var(--line)', paddingTop: '12px' }}>
              <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--slate)', marginBottom: '8px' }}>
                Sources cited
              </div>
              {citations.map(({ sourceNum, chunk }) => (
                <div key={chunk.id} style={{ fontSize: '11px', color: 'var(--slate)', marginBottom: '4px' }}>
                  <span style={{ fontFamily: "'Source Serif 4', serif", color: 'var(--ox)', marginRight: '6px' }}>[{sourceNum}]</span>
                  {chunk.sourceFile.split('/').pop()} {chunk.pageNumber ? `p.${chunk.pageNumber}` : chunk.lineNumber ? `L${chunk.lineNumber}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}
