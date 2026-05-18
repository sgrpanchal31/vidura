import { useState, useEffect } from 'react'
import Onboarding from './screens/Onboarding'
import './styles/globals.css'

type Screen = 'loading' | 'onboarding' | 'ready'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [notebookFolder, setNotebookFolder] = useState<string | null>(null)

  useEffect(() => {
    window.api.getPrefs().then((prefs) => {
      // TODO Day 11-12: if prefs.lastFolder exists, load chat screen instead
      setScreen('onboarding')
    })
  }, [])

  if (screen === 'loading') return null

  if (screen === 'ready' && notebookFolder) {
    return (
      <div className="app-window">
        <div style={{ padding: '64px 52px', color: 'var(--slate)', fontSize: '14px' }}>
          <span style={{ fontFamily: "'Source Serif 4', serif", fontStyle: 'italic', fontSize: '18px', color: 'var(--ink)', display: 'block', marginBottom: '12px' }}>
            Notebook ready
          </span>
          <span style={{ fontStyle: 'italic' }}>Folder:</span>{' '}
          <strong style={{ fontStyle: 'normal', color: 'var(--ink)' }}>{notebookFolder}</strong>
          <br />
          <span style={{ marginTop: '12px', display: 'block', opacity: 0.6, fontSize: '12px' }}>
            Chat UI coming in week 2 — Day 11-12.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="app-window">
      <Onboarding
        onComplete={(folder, modelId) => {
          window.api.setPrefs({ lastFolder: folder, modelId })
          setNotebookFolder(folder)
          setScreen('ready')
        }}
      />
    </div>
  )
}
