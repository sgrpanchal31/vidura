import { useState, useEffect, useRef } from 'react'
import './Chat.css'
import type { CitationEntry, NotebookState } from '../../../preload'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: CitationEntry[]
}

type SourceItem = {
  relativePath: string
  filename: string
  ext: string
}

type TreeNode = { type: 'file'; item: SourceItem } | { type: 'dir'; name: string; path: string; children: TreeNode[] }

type ChatProps = {
  folder: string
  modelId: string
  onChangeFolder: () => void
  onOpenSettings: () => void
}

const MODEL_LABELS: Record<string, string> = {
  'gemma4-e2b': 'Gemma 4 E2B',
  'llama3.2-3b': 'Llama 3.2 3B',
  'qwen2.5-7b': 'Qwen 2.5 7B',
  'gemma4-e4b': 'Gemma 4 E4B',
  'gemma4-12b': 'Gemma 4 12B',
}

function collectDirPaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes)
    if (n.type === 'dir') {
      out.add(n.path)
      collectDirPaths(n.children, out)
    }
  return out
}

function buildTree(sources: SourceItem[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const source of sources) {
    const parts = source.relativePath.split('/')
    let current = root
    let currentPath = ''

    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      currentPath = currentPath ? `${currentPath}/${name}` : name
      let dir = current.find((n) => n.type === 'dir' && n.name === name) as
        | Extract<TreeNode, { type: 'dir' }>
        | undefined
      if (!dir) {
        dir = { type: 'dir', name, path: currentPath, children: [] }
        current.push(dir)
      }
      current = dir.children
    }

    current.push({ type: 'file', item: source })
  }

  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      const nameA = a.type === 'dir' ? a.name : a.item.filename
      const nameB = b.type === 'dir' ? b.name : b.item.filename
      return nameA.localeCompare(nameB)
    })
    for (const n of nodes) if (n.type === 'dir') sortNodes(n.children)
  }
  sortNodes(root)
  return root
}

function renderTree(
  nodes: TreeNode[],
  level: number,
  collapsed: Set<string>,
  onToggle: (path: string) => void
): React.ReactNode {
  return nodes.map((node) => {
    if (node.type === 'file') {
      return (
        <div
          key={node.item.relativePath}
          className="source-file"
          style={{ paddingLeft: `${16 + level * 14}px` }}
          title={node.item.relativePath}
        >
          <span className="source-icon">{node.item.ext}</span>
          <span className="source-name">{node.item.filename}</span>
        </div>
      )
    }

    const isCollapsed = collapsed.has(node.path)
    return (
      <div key={node.path}>
        <div className="source-dir" style={{ paddingLeft: `${16 + level * 14}px` }} onClick={() => onToggle(node.path)}>
          <span className="source-dir-chevron" style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
            ▶
          </span>
          <span className="source-dir-name">{node.name}</span>
        </div>
        {!isCollapsed && renderTree(node.children, level + 1, collapsed, onToggle)}
      </div>
    )
  })
}

function buildSuggestions(sources: SourceItem[]): string[] {
  const count = sources.length
  if (count === 0) return []
  const firstName = sources[0].filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
  return [
    `What are the main ideas and key findings across these ${count} source${count !== 1 ? 's' : ''}?`,
    `Summarise the most important arguments in ${firstName}`,
    count > 1
      ? `What themes or topics appear across multiple sources in this folder?`
      : `What are the key conclusions I should take away from this material?`,
    `What questions does this material leave unanswered?`,
  ]
}

function parseInline(
  text: string,
  citations: CitationEntry[],
  onCite: (c: CitationEntry) => void,
  keyPrefix: string
): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g)
  return parts.map((part, i) => {
    const key = `${keyPrefix}-i${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="inline-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    const citeMatch = part.match(/^\[(\d+)\]$/)
    if (citeMatch) {
      const num = parseInt(citeMatch[1], 10)
      const citation = citations.find((c) => c.sourceNum === num)
      if (citation) {
        return (
          <span key={key} className="cite-inline" onClick={() => onCite(citation)}>
            {part}
          </span>
        )
      }
    }
    return <span key={key}>{part}</span>
  })
}

function renderMarkdown(
  content: string,
  citations: CitationEntry[],
  onCite: (c: CitationEntry) => void
): React.ReactNode {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }

    if (/^\s*[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*] /, ''))
        i++
      }
      elements.push(
        <ul key={elements.length}>
          {items.map((item, j) => (
            <li key={j}>{parseInline(item, citations, onCite, `ul${elements.length}-${j}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      elements.push(
        <ol key={elements.length}>
          {items.map((item, j) => (
            <li key={j}>{parseInline(item, citations, onCite, `ol${elements.length}-${j}`)}</li>
          ))}
        </ol>
      )
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*[-*] /.test(lines[i])) {
      paraLines.push(lines[i])
      i++
    }
    elements.push(
      <p key={elements.length}>{parseInline(paraLines.join(' '), citations, onCite, `p${elements.length}`)}</p>
    )
  }

  return <>{elements}</>
}

function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export default function Chat({ folder, modelId, onChangeFolder, onOpenSettings }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionCreatedAt, setSessionCreatedAt] = useState<number>(Date.now())
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamBuffer, setStreamBuffer] = useState('')
  const [activeCitation, setActiveCitation] = useState<CitationEntry | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesListRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const unsubsRef = useRef<Array<() => void>>([])

  const folderName = folder.split('/').pop() ?? folder
  const modelLabel = MODEL_LABELS[modelId] ?? modelId
  const hasMessages = messages.length > 0

  useEffect(() => {
    window.api
      .getIngestState(folder)
      .then((state: NotebookState) => {
        if (!state?.files) return
        const items: SourceItem[] = Object.values(state.files)
          .filter((f) => !f.failed && f.chunkCount > 0)
          .map((f) => ({
            relativePath: f.relativePath,
            filename: f.relativePath.split('/').pop() ?? f.relativePath,
            ext: (f.relativePath.split('.').pop() ?? 'file').toUpperCase().slice(0, 3),
          }))
        setSources(items)
        setCollapsedDirs(collectDirPaths(buildTree(items)))
        setSuggestions(buildSuggestions(items))
      })
      .catch(() => {})
  }, [folder])

  // Load the most recent session on mount; create a new one if none exists
  useEffect(() => {
    window.api
      .chatSessionList(folder)
      .then((sessions) => {
        const latest = sessions[0]
        if (latest) {
          return window.api.chatSessionLoad(folder, latest.id).then((session) => {
            if (session && session.messages.length > 0) {
              setMessages(session.messages as Message[])
              setSessionId(session.id)
              setSessionCreatedAt(session.createdAt)
            } else {
              setSessionId(newSessionId())
            }
            setSessionLoaded(true)
          })
        } else {
          setSessionId(newSessionId())
          setSessionLoaded(true)
        }
      })
      .catch(() => {
        setSessionId(newSessionId())
        setSessionLoaded(true)
      })
  }, [folder])

  // Save session to disk whenever messages change (fire-and-forget)
  useEffect(() => {
    if (!sessionLoaded || !sessionId) return
    const title = messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? ''
    window.api.chatSessionSave(folder, { id: sessionId, createdAt: sessionCreatedAt, title, messages })
  }, [messages, sessionLoaded, sessionId])
  // folder and sessionCreatedAt are stable for the lifetime of this session

  useEffect(() => {
    const el = messagesListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamBuffer])

  function toggleDir(path: string) {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function handleClear() {
    unsubsRef.current.forEach((u) => u())
    unsubsRef.current = []
    setMessages([])
    setStreamBuffer('')
    setActiveCitation(null)
    setIsGenerating(false)
    // Start a new session; old session stays on disk for future history feature
    setSessionId(newSessionId())
    setSessionCreatedAt(Date.now())
  }

  async function handleSend(text: string) {
    if (!text.trim() || isGenerating) return

    unsubsRef.current.forEach((u) => u())
    unsubsRef.current = []

    const userMsg: Message = {
      id: `${Date.now()}-u`,
      role: 'user',
      content: text.trim(),
      citations: [],
    }

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsGenerating(true)
    setStreamBuffer('')
    setActiveCitation(null)

    const unsubToken = window.api.onChatToken((tok) => setStreamBuffer((prev) => prev + tok))
    const unsubDone = window.api.onChatDone((result) => {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-a`, role: 'assistant', content: result.answer, citations: result.citations },
      ])
      setStreamBuffer('')
      setIsGenerating(false)
      cleanup()
    })
    const unsubError = window.api.onChatError((msg) => {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-e`, role: 'assistant', content: `Something went wrong: ${msg}`, citations: [] },
      ])
      setStreamBuffer('')
      setIsGenerating(false)
      cleanup()
    })

    function cleanup() {
      unsubToken()
      unsubDone()
      unsubError()
      unsubsRef.current = []
    }
    unsubsRef.current = [unsubToken, unsubDone, unsubError]

    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }))
    await window.api.chatAsk(text.trim(), folder, modelId, history)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend(input)
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }

  function handleCitationClick(citation: CitationEntry) {
    setActiveCitation((prev) =>
      prev?.sourceNum === citation.sourceNum && prev.chunk.id === citation.chunk.id ? null : citation
    )
  }

  const tree = buildTree(sources)

  return (
    <div className="chat-layout">
      {/* Titlebar */}
      <div className="chat-titlebar">
        <div className="chat-titlebar-center">
          <span className="chat-folder-name">{folderName}</span>
          <button className="chat-change-folder-btn" onClick={onChangeFolder} disabled={isGenerating}>
            Change
          </button>
          {sources.length > 0 && (
            <span className="chat-source-count">
              {sources.length} source{sources.length !== 1 ? 's' : ''}
            </span>
          )}
          {sources.length > 0 && <div className="chat-titlebar-sep" />}
          <span className="chat-model-badge">{modelLabel}</span>
        </div>
        {hasMessages && (
          <button className="chat-clear-btn" onClick={handleClear}>
            Clear chat
          </button>
        )}
      </div>

      {/* Body */}
      <div className="chat-body">
        {/* Sources panel — folder tree */}
        <div className="sources-panel">
          <div className="sources-header">Sources</div>
          <div className="sources-list">{renderTree(tree, 0, collapsedDirs, toggleDir)}</div>
          <button className="sources-settings-btn" onClick={onOpenSettings}>
            ⚙ Settings
          </button>
        </div>

        {/* Chat main */}
        <div className="chat-main">
          {hasMessages ? (
            <div className="messages-list" ref={messagesListRef}>
              {messages.map((msg) => (
                <div key={msg.id} className={`message message-${msg.role}`}>
                  <div className="message-bubble">
                    {msg.role === 'user'
                      ? msg.content
                      : renderMarkdown(msg.content, msg.citations, handleCitationClick)}
                  </div>
                </div>
              ))}
              {isGenerating && !streamBuffer && (
                <div className="message message-assistant">
                  <div className="message-bubble thinking-dots">
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                  </div>
                </div>
              )}
              {isGenerating && streamBuffer && (
                <div className="message message-assistant">
                  <div className="message-bubble message-streaming">
                    {streamBuffer}
                    <span className="stream-cursor">▋</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-content">
                <div className="empty-prompt">
                  What do you want to know
                  <br />
                  {sources.length > 0 ? `about your ${sources.length} sources?` : 'about your sources?'}
                </div>
                {suggestions.length > 0 && (
                  <div className="suggestions-box">
                    {suggestions.map((q, i) => (
                      <div key={i} className="suggestion-item" onClick={() => handleSend(q)}>
                        <span className="suggestion-arrow">→</span>
                        <span className="suggestion-text">{q}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Composer */}
          <div className="composer">
            <div className="composer-inner">
              <textarea
                ref={textareaRef}
                className="composer-textarea"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask your notebook…"
                disabled={isGenerating}
                rows={1}
              />
              {isGenerating ? (
                <button className="composer-cancel" onClick={() => window.api.chatCancel()}>
                  Stop
                </button>
              ) : (
                <span className="composer-hint">⌘ Return</span>
              )}
            </div>
          </div>

          {/* Status bar */}
          <div className={`statusbar${isGenerating ? ' generating' : ''}`}>
            <div className="status-dot" />
            <span className="status-text">
              {isGenerating ? 'Generating…' : `Indexed · ${sources.length} file${sources.length !== 1 ? 's' : ''}`}
            </span>
          </div>
        </div>

        {/* Citation preview panel */}
        {activeCitation && (
          <div className="preview-panel">
            <div className="preview-header">
              <div className="preview-cite-tag">Citation [{activeCitation.sourceNum}]</div>
              <div className="preview-filename" title={activeCitation.chunk.sourceFile}>
                {activeCitation.chunk.sourceFile.split('/').pop()}
              </div>
            </div>
            <div className="preview-scroll">
              <div className="preview-text">{activeCitation.chunk.text}</div>
            </div>
            <div className="preview-footer">
              {activeCitation.chunk.pageNumber
                ? `p. ${activeCitation.chunk.pageNumber}`
                : activeCitation.chunk.lineNumber
                  ? `L${activeCitation.chunk.lineNumber}`
                  : ''}
              {activeCitation.chunk.pageNumber || activeCitation.chunk.lineNumber ? ' · ' : ''}
              {activeCitation.chunk.sourceFile.split('/').pop()}
              <span className="preview-dismiss" onClick={() => setActiveCitation(null)}>
                {' '}
                · dismiss
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
