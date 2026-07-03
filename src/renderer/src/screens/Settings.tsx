import { useState, useEffect, useRef } from 'react'
import './Settings.css'
import type { LlmModelInfo, EmbedModelInfo, ModelProgress, PodcastVoices } from '../../../preload/index'

const LLM_META: Record<string, { name: string; desc: string }> = {
  'gemma4-e2b': {
    name: 'Gemma 4 E2B',
    desc: "Google's smallest Gemma 4 model. Fast and works on any Mac, including 8 GB models.",
  },
  'llama3.2-3b': {
    name: 'Llama 3.2 3B',
    desc: 'Slightly larger. Better on dense academic text and long-form sources.',
  },
  'gemma4-e4b': {
    name: 'Gemma 4 E4B',
    desc: "Google's efficient edge model. Better quality than E2B, works on 8 GB and 16 GB Macs.",
  },
  'gemma4-12b': {
    name: 'Gemma 4 12B',
    desc: 'High quality. Requires 24 GB RAM or more.',
  },
  'gpt-oss-20b': {
    name: 'GPT-OSS 20B',
    desc: "OpenAI's open-weight model. Top-tier reasoning and comprehension. Needs 32 GB RAM.",
  },
}

function recommendedLlmId(ramGB: number): string {
  if (ramGB >= 32) return 'gpt-oss-20b'
  if (ramGB >= 24) return 'gemma4-12b'
  return 'gemma4-e4b'
}

// Curated Kokoro voices (all bundled with the app, no extra download).
// Grades come from the Kokoro voice table; af_heart is the standout.
const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart: female, best quality' },
  { id: 'af_bella', label: 'Bella: female, great' },
  { id: 'af_nicole', label: 'Nicole: female, good' },
  { id: 'af_sarah', label: 'Sarah: female, decent' },
  { id: 'bf_emma', label: 'Emma: female, British' },
  { id: 'am_fenrir', label: 'Fenrir: male, decent' },
  { id: 'am_michael', label: 'Michael: male, decent' },
  { id: 'am_puck', label: 'Puck: male, decent' },
  { id: 'bm_george', label: 'George: male, British' },
  { id: 'bm_fable', label: 'Fable: male, British' },
]

// Must match VOICE_A / VOICE_B / VOICE_SOLO in src/main/services/tts.ts
const DEFAULT_VOICES: PodcastVoices = { hostA: 'af_heart', hostB: 'am_fenrir', solo: 'am_michael' }

type Section = 'llm' | 'embed' | 'retrieval' | 'audio'

type Props = {
  folder: string
  modelId: string
  onClose: () => void
  onModelChanged: (id: string) => void
}

export default function Settings({ folder, modelId, onClose, onModelChanged }: Props) {
  const [activeSection, setActiveSection] = useState<Section>('llm')
  const [llmModels, setLlmModels] = useState<LlmModelInfo[]>([])
  const [embedModel, setEmbedModel] = useState<EmbedModelInfo | null>(null)
  const [ramGB, setRamGB] = useState<number>(8)
  const [isMac, setIsMac] = useState(false)

  // LLM download / load state
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<ModelProgress | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)

  // Cancel confirmation — shown inline in progress row and on Back press
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // Brief hint when user clicks an undownloaded row
  const [hintId, setHintId] = useState<string | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Embed download state
  const [downloadingEmbed, setDownloadingEmbed] = useState(false)
  const [embedDownloadProgress, setEmbedDownloadProgress] = useState<{ loaded: number; total: number } | null>(null)
  const [embedError, setEmbedError] = useState<string | null>(null)

  // Reranker state
  const [rerankerEnabled, setRerankerEnabled] = useState(false)
  const [rerankerStatus, setRerankerStatus] = useState<string>('idle')
  const [rerankerDownloaded, setRerankerDownloaded] = useState(false)
  const [downloadingReranker, setDownloadingReranker] = useState(false)
  const [rerankerDownloadProgress, setRerankerDownloadProgress] = useState<{ loaded: number; total: number } | null>(
    null
  )
  const [rerankerError, setRerankerError] = useState<string | null>(null)
  const rerankerDownloadUnsubRef = useRef<(() => void) | null>(null)

  // Podcast audio state
  const [podcastVoices, setPodcastVoices] = useState<PodcastVoices>(DEFAULT_VOICES)

  const unsubRef = useRef<(() => void) | null>(null)
  const embedUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    Promise.all([
      window.api.listModels(),
      window.api.listEmbedModels(),
      window.api.getSystemInfo(),
      window.api.rerankerGetStatus(),
      window.api.getPrefs(),
    ]).then(([llms, embeds, sysInfo, reranker, prefs]) => {
      setLlmModels(llms)
      setEmbedModel(embeds[0] ?? null)
      setRamGB(sysInfo.totalRamGB)
      setIsMac(sysInfo.platform === 'darwin')
      setRerankerEnabled(reranker.enabled)
      setRerankerStatus(reranker.status)
      setRerankerDownloaded(reranker.downloaded)
      if (prefs.podcastVoices) setPodcastVoices(prefs.podcastVoices)
    })

    return () => {
      unsubRef.current?.()
      embedUnsubRef.current?.()
      rerankerDownloadUnsubRef.current?.()
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    }
  }, [folder])

  function showHint(id: string) {
    setHintId(id)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => setHintId(null), 2200)
  }

  // Back: if downloading, show cancel confirm instead of navigating away
  function handleBack() {
    if (downloadingId) {
      setShowCancelConfirm(true)
    } else {
      onClose()
    }
  }

  async function handleDownload(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (downloadingId) return

    setLlmError(null)
    setShowCancelConfirm(false)
    setDownloadingId(id)
    setDownloadProgress(null)

    const unsub = window.api.onModelProgress((p) => {
      if (p.modelId === id) setDownloadProgress(p)
    })
    unsubRef.current = unsub

    try {
      await window.api.modelDownload(id)
      setLlmModels(await window.api.listModels())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'DOWNLOAD_CANCELLED') {
        setLlmError(msg)
      }
    } finally {
      unsub()
      unsubRef.current = null
      setDownloadingId(null)
      setDownloadProgress(null)
      setShowCancelConfirm(false)
    }
  }

  async function confirmCancel() {
    // Actually cancel — main process deletes partial file
    await window.api.modelCancelDownload()
    // UI resets via the finally block in handleDownload
  }

  async function handleUse(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (loadingId || downloadingId) return

    setLlmError(null)
    setLoadingId(id)
    try {
      await window.api.modelLoad(id)
      await window.api.setPrefs({ modelId: id })
      onModelChanged(id)
      setLlmModels(await window.api.listModels())
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err))
    }
    setLoadingId(null)
  }

  async function handleDeleteLlm(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await window.api.modelDelete(id)
      setLlmModels(await window.api.listModels())
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDownloadEmbed(e: React.MouseEvent) {
    e.stopPropagation()
    if (downloadingEmbed || !embedModel) return

    setEmbedError(null)
    setDownloadingEmbed(true)
    setEmbedDownloadProgress(null)

    const unsub = window.api.onEmbedDownloadProgress((p) => {
      setEmbedDownloadProgress({ loaded: p.loaded, total: p.total })
    })
    embedUnsubRef.current = unsub

    try {
      await window.api.embedEnsure()
      const embeds = await window.api.listEmbedModels()
      setEmbedModel(embeds[0] ?? null)
    } catch (err) {
      setEmbedError(err instanceof Error ? err.message : String(err))
    } finally {
      unsub()
      embedUnsubRef.current = null
      setDownloadingEmbed(false)
      setEmbedDownloadProgress(null)
    }
  }

  async function handleDownloadReranker() {
    if (downloadingReranker) return
    setRerankerError(null)
    setDownloadingReranker(true)
    setRerankerDownloadProgress(null)
    const unsub = window.api.onModelProgress((p) => {
      if (p.modelId === 'bge-reranker-v2-m3') {
        setRerankerDownloadProgress({ loaded: p.downloaded, total: p.total })
      }
    })
    rerankerDownloadUnsubRef.current = unsub
    try {
      await window.api.modelDownload('bge-reranker-v2-m3')
      const status = await window.api.rerankerGetStatus()
      setRerankerDownloaded(status.downloaded)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'DOWNLOAD_CANCELLED') setRerankerError(msg)
    } finally {
      unsub()
      rerankerDownloadUnsubRef.current = null
      setDownloadingReranker(false)
      setRerankerDownloadProgress(null)
    }
  }

  async function handleRerankerToggle(enabled: boolean) {
    setRerankerError(null)
    if (enabled) {
      setRerankerStatus('starting')
      try {
        await window.api.rerankerSetEnabled(true)
        setRerankerEnabled(true)
        setRerankerStatus('ready')
      } catch (err) {
        setRerankerStatus('error')
        setRerankerError(err instanceof Error ? err.message : String(err))
      }
    } else {
      await window.api.rerankerSetEnabled(false)
      setRerankerEnabled(false)
      setRerankerStatus('idle')
    }
  }

  async function handleVoiceChange(role: keyof PodcastVoices, voiceId: string) {
    const next = { ...podcastVoices, [role]: voiceId }
    setPodcastVoices(next)
    await window.api.setPrefs({ podcastVoices: next })
  }

  const recommendedLlm = recommendedLlmId(ramGB)
  const busy = !!downloadingId || !!loadingId

  const NAV_ITEMS: { id: Section; label: string }[] = [
    { id: 'llm', label: 'Language model' },
    { id: 'embed', label: 'Embedding model' },
    { id: 'retrieval', label: 'Retrieval' },
    { id: 'audio', label: 'Podcast audio' },
  ]

  return (
    <div className="settings-root">
      {/* Titlebar */}
      <div className="settings-titlebar">
        {isMac && <div className="settings-traffic-spacer" />}
        <button className="settings-back-btn" onClick={handleBack}>
          ← Back
        </button>
        <span className="settings-title">Settings</span>
      </div>

      {/* Main: nav sidebar + content */}
      <div className="settings-main">
        {/* Nav */}
        <nav className="settings-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
              onClick={() => setActiveSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="settings-content">
          {/* ── Language model ── */}
          {activeSection === 'llm' && (
            <div className="settings-section">
              <div className="settings-section-title">Language model</div>
              <div className="settings-section-note">
                Controls how responses are generated. Larger models are more capable but require more RAM.
              </div>
              {llmError && <div className="settings-error">{llmError}</div>}

              <div className="settings-model-list">
                {llmModels.map((m) => {
                  const meta = LLM_META[m.id]
                  const isActive = m.id === modelId
                  const isDownloading = downloadingId === m.id
                  const isLoading = loadingId === m.id
                  const pct =
                    isDownloading && downloadProgress != null && downloadProgress.total > 0
                      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
                      : null

                  // Downloading: show progress row or cancel confirm
                  if (isDownloading) {
                    if (showCancelConfirm) {
                      return (
                        <div key={m.id} className="settings-confirm-row">
                          <span className="settings-confirm-text">
                            Stop downloading? The partial file will be deleted.
                          </span>
                          <div className="settings-confirm-actions">
                            <button className="settings-confirm-cancel" onClick={() => setShowCancelConfirm(false)}>
                              Keep downloading
                            </button>
                            <button className="settings-confirm-ok" onClick={confirmCancel}>
                              Stop
                            </button>
                          </div>
                        </div>
                      )
                    }

                    return (
                      <div key={m.id} className="settings-row-progress">
                        <div className="settings-progress-header">
                          <span className="settings-progress-label">
                            Downloading {meta?.name ?? m.id}
                            {pct !== null ? ` — ${pct}%` : '…'}
                          </span>
                          <button className="settings-cancel-download-btn" onClick={() => setShowCancelConfirm(true)}>
                            Cancel
                          </button>
                        </div>
                        <div className="settings-progress-track">
                          <div className="settings-progress-fill" style={{ width: pct !== null ? `${pct}%` : '0%' }} />
                        </div>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={m.id}
                      className={`settings-model-row${isActive ? ' sel' : ''}${busy && !isActive ? ' disabled' : ''}${!m.downloaded ? ' clickable' : ''}`}
                      onClick={!m.downloaded ? () => showHint(m.id) : undefined}
                    >
                      <div className="settings-radio" />
                      <div className="settings-model-info">
                        <div className="settings-model-name">
                          {meta?.name ?? m.id}
                          {m.id === recommendedLlm && <span className="tag-rec">Recommended</span>}
                        </div>
                        <div className="settings-model-desc">{meta?.desc ?? ''}</div>
                      </div>
                      <div className="settings-model-meta">
                        <div className="settings-model-size">{(m.sizeBytes / 1e9).toFixed(1)} GB</div>
                        <div className="settings-model-actions">
                          {isActive && <span className="settings-badge active">Selected</span>}
                          {!isActive && m.downloaded && (
                            <>
                              <button className="settings-use-btn" onClick={(e) => handleUse(m.id, e)} disabled={busy}>
                                {isLoading ? 'Loading…' : 'Use'}
                              </button>
                              <button
                                className="settings-delete-btn"
                                onClick={(e) => handleDeleteLlm(m.id, e)}
                                disabled={busy}
                              >
                                Delete
                              </button>
                            </>
                          )}
                          {!m.downloaded && (
                            <div className="settings-download-group">
                              {hintId === m.id && <span className="settings-download-hint">Download first</span>}
                              <button
                                className={`settings-download-btn${hintId === m.id ? ' hint-pulse' : ''}`}
                                onClick={(e) => handleDownload(m.id, e)}
                                disabled={busy}
                              >
                                Download
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="settings-coming-soon">Coming soon: switch models per chat</div>
            </div>
          )}

          {/* ── Retrieval ── */}
          {activeSection === 'retrieval' && (
            <div className="settings-section">
              <div className="settings-section-title">Retrieval</div>
              <div className="settings-section-note">
                Controls how passages are scored and ranked before being sent to the language model.
              </div>
              {rerankerError && <div className="settings-error">{rerankerError}</div>}
              <div className="settings-model-list">
                {downloadingReranker ? (
                  <div className="settings-row-progress">
                    <div className="settings-progress-header">
                      <span className="settings-progress-label">
                        Downloading BGE Reranker V2 M3
                        {rerankerDownloadProgress && rerankerDownloadProgress.total > 0
                          ? ` — ${Math.round((rerankerDownloadProgress.loaded / rerankerDownloadProgress.total) * 100)}%`
                          : '…'}
                      </span>
                    </div>
                    <div className="settings-progress-track">
                      <div
                        className="settings-progress-fill"
                        style={{
                          width:
                            rerankerDownloadProgress && rerankerDownloadProgress.total > 0
                              ? `${Math.round((rerankerDownloadProgress.loaded / rerankerDownloadProgress.total) * 100)}%`
                              : '0%',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="settings-model-row">
                    <div className="settings-model-info">
                      <div className="settings-model-name">BGE Reranker V2 M3</div>
                      <div className="settings-model-desc">
                        Re-scores retrieved passages with a cross-encoder for more relevant answers. Runs on-device via
                        the same engine as the language model.
                      </div>
                      {rerankerEnabled && rerankerStatus === 'starting' && (
                        <div className="settings-progress-label" style={{ marginTop: 6 }}>
                          Loading model…
                        </div>
                      )}
                    </div>
                    <div className="settings-model-meta">
                      <div className="settings-model-size">~600 MB</div>
                      <div className="settings-model-actions">
                        {rerankerDownloaded ? (
                          <>
                            {rerankerEnabled && rerankerStatus === 'ready' && (
                              <span className="settings-badge active">Active</span>
                            )}
                            <button
                              className={`reranker-toggle${rerankerEnabled ? ' on' : ''}`}
                              onClick={() => handleRerankerToggle(!rerankerEnabled)}
                              disabled={rerankerStatus === 'starting'}
                              aria-label={rerankerEnabled ? 'Disable reranker' : 'Enable reranker'}
                            />
                          </>
                        ) : (
                          <button className="settings-download-btn" onClick={handleDownloadReranker}>
                            Download
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Embedding model ── */}
          {activeSection === 'embed' && embedModel && (
            <div className="settings-section">
              <div className="settings-section-title">Embedding model</div>
              <div className="settings-section-note">
                Used to index your sources and find relevant passages when you ask a question. Runs entirely on your Mac
                — no internet connection required after download.
              </div>
              {embedError && <div className="settings-error">{embedError}</div>}
              <div className="settings-model-list">
                {downloadingEmbed ? (
                  <div className="settings-row-progress">
                    <div className="settings-progress-header">
                      <span className="settings-progress-label">
                        Downloading {embedModel.name}
                        {embedDownloadProgress && embedDownloadProgress.total > 0
                          ? ` — ${Math.round((embedDownloadProgress.loaded / embedDownloadProgress.total) * 100)}%`
                          : '…'}
                      </span>
                    </div>
                    <div className="settings-progress-track">
                      <div
                        className="settings-progress-fill"
                        style={{
                          width:
                            embedDownloadProgress && embedDownloadProgress.total > 0
                              ? `${Math.round((embedDownloadProgress.loaded / embedDownloadProgress.total) * 100)}%`
                              : '0%',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="settings-model-row sel">
                    <div className="settings-radio" />
                    <div className="settings-model-info">
                      <div className="settings-model-name">
                        {embedModel.name}
                        {embedModel.recommended && <span className="tag-rec">Recommended</span>}
                        {embedModel.tags
                          .filter((t) => t !== 'Recommended')
                          .map((t) => (
                            <span key={t} className="tag-info">
                              {t}
                            </span>
                          ))}
                      </div>
                      <div className="settings-model-desc">{embedModel.desc}</div>
                    </div>
                    <div className="settings-model-meta">
                      <div className="settings-model-size">{embedModel.sizeLabel}</div>
                      <div className="settings-model-actions">
                        {embedModel.downloaded ? (
                          <span className="settings-badge active">Downloaded</span>
                        ) : (
                          <button className="settings-download-btn" onClick={handleDownloadEmbed}>
                            Download
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {/* ── Podcast audio ── */}
          {activeSection === 'audio' && (
            <div className="settings-section">
              <div className="settings-section-title">Podcast audio</div>
              <div className="settings-section-note">
                Controls the speech engine and voices used when generating podcast episodes. Changes apply to the next
                episode you create.
              </div>

              <div className="settings-model-list">
                <div className="settings-model-row sel">
                  <div className="settings-radio" />
                  <div className="settings-model-info">
                    <div className="settings-model-name">Kokoro 82M</div>
                    <div className="settings-model-desc">
                      Lightweight neural text to speech that runs entirely on your Mac. More engines will appear here as
                      they become available.
                    </div>
                  </div>
                  <div className="settings-model-meta">
                    <div className="settings-model-size">~92 MB</div>
                    <div className="settings-model-actions">
                      <span className="settings-badge active">Selected</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-voice-list">
                {(
                  [
                    { role: 'hostA', name: 'Host A (Maya)', desc: 'Warm, curious host who opens the show' },
                    { role: 'hostB', name: 'Host B (Sam)', desc: 'Calm, knowledgeable co-host' },
                    { role: 'solo', name: 'Narrator', desc: 'Used for single-voice podcasts' },
                  ] as { role: keyof PodcastVoices; name: string; desc: string }[]
                ).map(({ role, name, desc }) => (
                  <div key={role} className="settings-voice-row">
                    <div className="settings-model-info">
                      <div className="settings-model-name">{name}</div>
                      <div className="settings-model-desc">{desc}</div>
                    </div>
                    <select
                      className="settings-voice-select"
                      value={podcastVoices[role]}
                      onChange={(e) => handleVoiceChange(role, e.target.value)}
                    >
                      {KOKORO_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
