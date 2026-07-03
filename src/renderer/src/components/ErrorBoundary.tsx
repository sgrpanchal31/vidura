import React from 'react'

type State = { error: Error | null }

// Last-resort guard: without this, a render-time exception white-screens the
// whole window with no way for a tester to tell us what happened.
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          fontFamily: "'IBM Plex Sans', sans-serif",
          color: 'var(--ink)',
          background: 'var(--cream)',
          padding: 40,
          textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: "'Source Serif 4', serif", fontStyle: 'italic', fontSize: 20 }}>
          Something went wrong
        </div>
        <div style={{ fontSize: 13, color: 'var(--slate)', maxWidth: 420 }}>
          Vidura hit an unexpected error. Restarting usually fixes it. If it keeps happening, please copy the details
          below into an issue at github.com/sgrpanchal31/vidura/issues
        </div>
        <pre
          style={{
            fontSize: 11,
            fontFamily: "'IBM Plex Mono', monospace",
            color: 'var(--slate)',
            background: 'var(--cream-d)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '10px 14px',
            maxWidth: 520,
            maxHeight: 160,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
            userSelect: 'text',
          }}
        >
          {this.state.error.stack ?? this.state.error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 18px',
            borderRadius: 5,
            border: 'none',
            background: 'var(--ox)',
            color: 'var(--cream)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Restart Vidura
        </button>
      </div>
    )
  }
}
