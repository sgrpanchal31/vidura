import { useState, useEffect, useRef } from 'react'
import './Chat.css'
import type { CitationEntry, NotebookState } from '../../../preload'

// ── Types ─────────────────────────────────────────────────────────────────────

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

type SessionSummary = {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  type?: 'chat' | 'podcast'
}

type ActiveCitation = {
  entry: CitationEntry
  rect: DOMRect
}

type GeneratingSnapshot = {
  sessionId: string
  createdAt: number
  type: 'chat' | 'podcast'
  messages: Message[]
}

type ChatProps = {
  folder: string
  modelId: string
  onChangeFolder: () => void
  onOpenSettings: () => void
  initialSessionId?: string | null
  onSessionIdChange?: (id: string) => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_LABELS: Record<string, string> = {
  'gemma4-e2b': 'Gemma 4 E2B',
  'llama3.2-3b': 'Llama 3.2 3B',
  'gemma4-e4b': 'Gemma 4 E4B',
  'gemma4-12b': 'Gemma 4 12B',
  'gpt-oss-20b': 'GPT-OSS 20B',
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function IconPlus({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <line x1="7" y1="2" x2="7" y2="12" />
      <line x1="2" y1="7" x2="12" y2="7" />
    </svg>
  )
}

function IconMic({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="4.5" y="1" width="5" height="7" rx="2.5" />
      <path d="M2 7.5a5 5 0 0 0 10 0" />
      <line x1="7" y1="12.5" x2="7" y2="10.5" />
    </svg>
  )
}

function IconTrash({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <line x1="2" y1="3.5" x2="12" y2="3.5" />
      <path d="M5 3.5V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" />
      <path d="M3 3.5l.8 8.5h6.4l.8-8.5" />
    </svg>
  )
}

function IconSidebar({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="1" y="1" width="13" height="13" rx="2" />
      <line x1="5" y1="1" x2="5" y2="14" />
    </svg>
  )
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

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

// ── Suggestions ───────────────────────────────────────────────────────────────

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

// ── Markdown rendering ────────────────────────────────────────────────────────

function parseInline(
  text: string,
  citations: CitationEntry[],
  onCiteEnter: (c: CitationEntry, e: React.MouseEvent) => void,
  onCiteLeave: () => void,
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
          <span
            key={key}
            className="cite-inline"
            onMouseEnter={(e) => onCiteEnter(citation, e)}
            onMouseLeave={onCiteLeave}
          >
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
  onCiteEnter: (c: CitationEntry, e: React.MouseEvent) => void,
  onCiteLeave: () => void
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
            <li key={j}>{parseInline(item, citations, onCiteEnter, onCiteLeave, `ul${elements.length}-${j}`)}</li>
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
            <li key={j}>{parseInline(item, citations, onCiteEnter, onCiteLeave, `ol${elements.length}-${j}`)}</li>
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
      <p key={elements.length}>
        {parseInline(paraLines.join(' '), citations, onCiteEnter, onCiteLeave, `p${elements.length}`)}
      </p>
    )
  }
  return <>{elements}</>
}

// ── Session ID ────────────────────────────────────────────────────────────────

function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ── Chat component ────────────────────────────────────────────────────────────

export default function Chat({
  folder,
  modelId,
  onChangeFolder,
  onOpenSettings,
  initialSessionId,
  onSessionIdChange,
}: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionCreatedAt, setSessionCreatedAt] = useState<number>(Date.now())
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamBuffer, setStreamBuffer] = useState('')
  const [activeCitation, setActiveCitation] = useState<ActiveCitation | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const [isReindexing, setIsReindexing] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentSessionType, setCurrentSessionType] = useState<'chat' | 'podcast'>('chat')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [generatingSessionId, setGeneratingSessionId] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesListRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const unsubsRef = useRef<Array<() => void>>([])
  const tooltipCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<Map<string, string>>(new Map())
  const deletedSessionIdsRef = useRef<Set<string>>(new Set())
  const generatingSessionIdRef = useRef<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const generatingSnapshotRef = useRef<GeneratingSnapshot | null>(null)
  const newChatDraftRef = useRef<string>('')
  const newPodcastDraftRef = useRef<string>('')

  const folderName = folder.split('/').pop() ?? folder
  const modelLabel = MODEL_LABELS[modelId] ?? modelId
  const hasMessages = messages.length > 0

  // ── Helpers ───────────────────────────────────────────────────────────────

  function truncateAtWord(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    const cut = text.slice(0, maxLen)
    const lastSpace = cut.lastIndexOf(' ')
    return lastSpace > 0 ? cut.slice(0, lastSpace) : cut
  }

  async function loadSessionsList(): Promise<SessionSummary[]> {
    const list = await window.api.chatSessionList(folder)
    const typed = (list as SessionSummary[]).filter((s) => !deletedSessionIdsRef.current.has(s.id))
    setSessions(typed)
    return typed
  }

  function refreshSources() {
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
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    refreshSources()
  }, [folder])

  useEffect(() => {
    const unsub = window.api.onWatchStatus(({ active }) => {
      setIsReindexing(active)
      if (!active) refreshSources()
    })
    return unsub
  }, [folder])

  // Load sessions list and restore the last active session (or fall back to newest) on mount
  useEffect(() => {
    loadSessionsList()
      .then((list) => {
        const targetId = initialSessionId ?? list[0]?.id
        if (targetId) {
          return window.api.chatSessionLoad(folder, targetId).then((session) => {
            if (session && session.messages.length > 0) {
              setMessages(session.messages as Message[])
              setSessionId(session.id)
              setSessionCreatedAt(session.createdAt)
              setCurrentSessionType(session.type ?? 'chat')
              setSessionLoaded(true)
            } else if (list[0] && list[0].id !== targetId) {
              // initialSessionId had no messages — fall back to newest
              return window.api.chatSessionLoad(folder, list[0].id).then((s) => {
                if (s && s.messages.length > 0) {
                  setMessages(s.messages as Message[])
                  setSessionId(s.id)
                  setSessionCreatedAt(s.createdAt)
                  setCurrentSessionType(s.type ?? 'chat')
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

  // Notify parent whenever the active session changes (so it can restore it after Settings)
  useEffect(() => {
    if (sessionId) onSessionIdChange?.(sessionId)
  }, [sessionId])

  // Keep a ref in sync with sessionId for closure-safe access inside IPC callbacks
  useEffect(() => {
    currentSessionIdRef.current = sessionId
  }, [sessionId])

  // Save session to disk whenever messages change (fire-and-forget)
  useEffect(() => {
    if (!sessionLoaded || !sessionId) return
    if (messages.length === 0) return
    const firstUserContent = messages.find((m) => m.role === 'user')?.content ?? ''
    const cleanContent =
      currentSessionType === 'podcast' ? firstUserContent.replace(/^\/podcast\s*/i, '').trim() : firstUserContent
    const title =
      currentSessionType === 'podcast'
        ? `Podcast: ${truncateAtWord(cleanContent, 45)}`
        : truncateAtWord(firstUserContent, 60)
    window.api.chatSessionSave(folder, {
      id: sessionId,
      createdAt: sessionCreatedAt,
      updatedAt: Date.now(),
      title,
      type: currentSessionType,
      messages,
    })
  }, [messages, sessionLoaded, sessionId, currentSessionType])

  useEffect(() => {
    const el = messagesListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamBuffer])

  // ── Handlers ──────────────────────────────────────────────────────────────

  function toggleDir(path: string) {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function resetViewToBlank() {
    setMessages([])
    setStreamBuffer('')
    setGenerateStatus('')
    setActiveCitation(null)
    setInput('')
    setConfirmDeleteId(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  function clearChatState() {
    unsubsRef.current.forEach((u) => u())
    unsubsRef.current = []
    setIsGenerating(false)
    resetViewToBlank()
  }

  function handleNewChat() {
    // Already on a blank chat session: preserve typed text, just focus
    if (messages.length === 0 && currentSessionType === 'chat') {
      textareaRef.current?.focus()
      return
    }
    // Switching type on a blank session: swap drafts, don't create new session ID
    if (messages.length === 0 && currentSessionType === 'podcast') {
      newPodcastDraftRef.current = input
      const restored = newChatDraftRef.current
      setCurrentSessionType('chat')
      setInput(restored)
      setTimeout(() => {
        if (textareaRef.current) {
          const ta = textareaRef.current
          ta.style.height = 'auto'
          if (restored) ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
          ta.focus()
        }
      }, 0)
      return
    }
    // Has messages: navigate to a new blank session
    if (sessionId) draftRef.current.set(sessionId, input)
    const newSid = newSessionId()
    currentSessionIdRef.current = newSid
    setSessionId(newSid)
    setSessionCreatedAt(Date.now())
    setCurrentSessionType('chat')
    if (isGenerating) {
      resetViewToBlank()
      setInput(newChatDraftRef.current)
    } else {
      clearChatState()
      setInput(newChatDraftRef.current)
    }
  }

  function handleNewPodcast() {
    // Already on a blank podcast session: preserve typed text, just focus
    if (messages.length === 0 && currentSessionType === 'podcast') {
      textareaRef.current?.focus()
      return
    }
    // Switching type on a blank session: swap drafts, don't create new session ID
    if (messages.length === 0 && currentSessionType === 'chat') {
      newChatDraftRef.current = input
      const restored = newPodcastDraftRef.current || '/podcast Create a podcast script from my documents'
      setCurrentSessionType('podcast')
      setInput(restored)
      setTimeout(() => {
        if (textareaRef.current) {
          const ta = textareaRef.current
          ta.style.height = 'auto'
          ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
          ta.focus()
        }
      }, 0)
      return
    }
    // Has messages: navigate to a new blank session
    if (sessionId) draftRef.current.set(sessionId, input)
    const newSid = newSessionId()
    currentSessionIdRef.current = newSid
    setSessionId(newSid)
    setSessionCreatedAt(Date.now())
    setCurrentSessionType('podcast')
    const podcastInput = newPodcastDraftRef.current || '/podcast Create a podcast script from my documents'
    if (isGenerating) {
      resetViewToBlank()
      setInput(podcastInput)
    } else {
      clearChatState()
      setInput(podcastInput)
    }
    setTimeout(() => {
      if (textareaRef.current) {
        const ta = textareaRef.current
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
        ta.focus()
      }
    }, 0)
  }

  async function handleSessionSelect(sid: string) {
    if (sid === sessionId) return
    const session = await window.api.chatSessionLoad(folder, sid)
    if (!session) return
    if (sessionId) draftRef.current.set(sessionId, input)
    currentSessionIdRef.current = session.id
    setMessages(session.messages as Message[])
    setSessionId(session.id)
    setSessionCreatedAt(session.createdAt)
    setCurrentSessionType(session.type ?? 'chat')
    setStreamBuffer('')
    setGenerateStatus('')
    setActiveCitation(null)
    const restored = draftRef.current.get(sid) ?? ''
    setInput(restored)
    setConfirmDeleteId(null)
    if (textareaRef.current) {
      const ta = textareaRef.current
      ta.style.height = 'auto'
      if (restored) ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    }
  }

  async function handleDeleteConfirm(sid: string) {
    deletedSessionIdsRef.current.add(sid)
    setSessions((prev) => prev.filter((s) => s.id !== sid))
    setConfirmDeleteId(null)
    if (sid === sessionId) handleNewChat()

    try {
      await window.api.chatSessionDelete(folder, sid)
    } catch {
      // file may not exist, or IPC error — UI is already correct
    }
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

    // Capture messages INCLUDING the user question so onChatDone can reconstruct
    // the full session if the user navigates away before generation completes
    const messagesWithUser = [...messages, userMsg]
    setMessages(messagesWithUser)

    // Optimistically add to sidebar on first message so it appears immediately
    if (messages.length === 0) {
      setSessions((prev) => {
        if (prev.some((s) => s.id === sessionId)) return prev
        return [
          {
            id: sessionId!,
            createdAt: sessionCreatedAt,
            updatedAt: Date.now(),
            title: truncateAtWord(text.trim(), 60),
            type: currentSessionType,
          },
          ...prev,
        ]
      })
    }
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsGenerating(true)
    setGeneratingSessionId(sessionId)
    generatingSessionIdRef.current = sessionId
    generatingSnapshotRef.current = {
      sessionId: sessionId!,
      createdAt: sessionCreatedAt,
      type: currentSessionType,
      messages: messagesWithUser,
    }
    setStreamBuffer('')
    setGenerateStatus('')
    setActiveCitation(null)

    const unsubChatProgress = window.api.onChatProgress((p) => {
      if (p.stage === 'reading') setGenerateStatus('Reading documents...')
      else if (p.stage === 'reranking') setGenerateStatus('Finding best matches...')
      else if (p.stage === 'generating') setGenerateStatus('Writing response...')
    })
    const unsubProgress = window.api.onGenerateProgress((p) => {
      if (p.stage === 'map') setGenerateStatus('Reading documents...')
      else if (p.stage === 'reduce') setGenerateStatus('Organizing ideas...')
      else if (p.stage === 'final')
        setGenerateStatus(p.type === 'podcast' ? 'Writing your podcast...' : 'Writing your summary...')
    })
    // Only buffer tokens when the user is still viewing the generating session
    const unsubToken = window.api.onChatToken((tok) => {
      if (currentSessionIdRef.current === generatingSessionIdRef.current) {
        setStreamBuffer((prev) => prev + tok)
      }
    })
    const unsubDone = window.api.onChatDone((result) => {
      const snapshot = generatingSnapshotRef.current
      const assistantMsg: Message = {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: result.answer,
        citations: result.citations as CitationEntry[],
      }

      if (currentSessionIdRef.current === snapshot?.sessionId) {
        // Still viewing the generating session — normal state update (save effect handles disk)
        setMessages((prev) => [...prev, assistantMsg])
      } else if (snapshot) {
        // User navigated away — save completed session directly to disk
        const firstUserContent = snapshot.messages.find((m) => m.role === 'user')?.content ?? ''
        const cleanContent =
          snapshot.type === 'podcast' ? firstUserContent.replace(/^\/podcast\s*/i, '').trim() : firstUserContent
        const title =
          snapshot.type === 'podcast'
            ? `Podcast: ${truncateAtWord(cleanContent, 45)}`
            : truncateAtWord(firstUserContent, 60)
        window.api.chatSessionSave(folder, {
          id: snapshot.sessionId,
          createdAt: snapshot.createdAt,
          updatedAt: Date.now(),
          title,
          type: snapshot.type,
          messages: [...snapshot.messages, assistantMsg],
        })
      }

      generatingSessionIdRef.current = null
      generatingSnapshotRef.current = null
      setGeneratingSessionId(null)
      setStreamBuffer('')
      setGenerateStatus('')
      setIsGenerating(false)
      cleanup()
      loadSessionsList().catch(() => {})
    })
    const unsubError = window.api.onChatError((msg) => {
      const snapshot = generatingSnapshotRef.current
      const errorMsg: Message = {
        id: `${Date.now()}-e`,
        role: 'assistant',
        content: `Something went wrong: ${msg}`,
        citations: [],
      }

      if (currentSessionIdRef.current === snapshot?.sessionId) {
        setMessages((prev) => [...prev, errorMsg])
      } else if (snapshot) {
        const firstUserContent = snapshot.messages.find((m) => m.role === 'user')?.content ?? ''
        const cleanContent =
          snapshot.type === 'podcast' ? firstUserContent.replace(/^\/podcast\s*/i, '').trim() : firstUserContent
        const title =
          snapshot.type === 'podcast'
            ? `Podcast: ${truncateAtWord(cleanContent, 45)}`
            : truncateAtWord(firstUserContent, 60)
        window.api.chatSessionSave(folder, {
          id: snapshot.sessionId,
          createdAt: snapshot.createdAt,
          updatedAt: Date.now(),
          title,
          type: snapshot.type,
          messages: [...snapshot.messages, errorMsg],
        })
      }

      generatingSessionIdRef.current = null
      generatingSnapshotRef.current = null
      setGeneratingSessionId(null)
      setStreamBuffer('')
      setGenerateStatus('')
      setIsGenerating(false)
      cleanup()
    })

    function cleanup() {
      unsubChatProgress()
      unsubProgress()
      unsubToken()
      unsubDone()
      unsubError()
      unsubsRef.current = []
    }
    unsubsRef.current = [unsubChatProgress, unsubProgress, unsubToken, unsubDone, unsubError]

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

  function handleCitationEnter(citation: CitationEntry, event: React.MouseEvent) {
    if (tooltipCloseTimerRef.current) clearTimeout(tooltipCloseTimerRef.current)
    const rect = (event.currentTarget as Element).getBoundingClientRect()
    setActiveCitation({ entry: citation, rect })
  }

  function handleCitationLeave() {
    tooltipCloseTimerRef.current = setTimeout(() => setActiveCitation(null), 120)
  }

  function handleTooltipEnter() {
    if (tooltipCloseTimerRef.current) clearTimeout(tooltipCloseTimerRef.current)
  }

  function handleTooltipLeave() {
    tooltipCloseTimerRef.current = setTimeout(() => setActiveCitation(null), 120)
  }

  const tree = buildTree(sources)

  // Compute tooltip position: fixed to viewport, smart top/bottom based on citation location
  const tooltipStyle: React.CSSProperties | null = activeCitation
    ? (() => {
        const { rect } = activeCitation
        const windowHeight = window.innerHeight
        const showAbove = rect.top > windowHeight * 0.55
        return {
          position: 'fixed' as const,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 380)),
          ...(showAbove ? { bottom: windowHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
          width: 360,
          zIndex: 50,
        }
      })()
    : null

  return (
    <div className="chat-layout">
      {/* Titlebar */}
      <div className="chat-titlebar">
        <button
          className="chat-sidebar-toggle"
          onClick={() => setSidebarCollapsed((p) => !p)}
          title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
        >
          <IconSidebar size={15} />
        </button>
        <div className="chat-titlebar-center">
          <span className="chat-folder-name">{folderName}</span>
          <button className="chat-change-folder-btn" onClick={onChangeFolder} disabled={isGenerating}>
            Change
          </button>
          <div className="chat-titlebar-sep" />
          <span className="chat-model-badge">{modelLabel}</span>
        </div>
      </div>

      {/* Body */}
      <div className="chat-body">
        {/* Sidebar */}
        <div className={`sidebar${sidebarCollapsed ? ' sidebar--collapsed' : ''}`}>
          {/* Create tiles */}
          <div className="sidebar-create">
            <button className="create-tile" onClick={handleNewChat} title="New Chat">
              <IconPlus size={14} />
              {!sidebarCollapsed && <span>New Chat</span>}
            </button>
            <button className="create-tile" onClick={handleNewPodcast} title="New Podcast">
              <IconMic size={14} />
              {!sidebarCollapsed && <span>New Podcast</span>}
            </button>
          </div>

          {!sidebarCollapsed && (
            <>
              <div className="sidebar-divider" />
              <div className="sidebar-sessions">
                {sessions.map((s) => (
                  <div key={s.id} className={`session-item${s.id === sessionId ? ' session-item--active' : ''}`}>
                    {confirmDeleteId === s.id ? (
                      <div className="session-delete-confirm">
                        <span>Delete?</span>
                        <button onClick={() => handleDeleteConfirm(s.id)}>Yes</button>
                        <button onClick={() => setConfirmDeleteId(null)}>No</button>
                      </div>
                    ) : (
                      <>
                        <span className="session-icon">{s.type === 'podcast' ? <IconMic size={11} /> : null}</span>
                        <span className="session-title" onClick={() => handleSessionSelect(s.id)}>
                          {s.title || 'New chat'}
                        </span>
                        {s.id === generatingSessionId ? (
                          <span className="session-generating-dot" title="Generating…" />
                        ) : (
                          <button
                            className="session-delete-btn"
                            onClick={() => setConfirmDeleteId(s.id)}
                            title="Delete chat"
                            disabled={isGenerating}
                          >
                            <IconTrash size={11} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <button className="sidebar-settings-btn" onClick={onOpenSettings} title="Settings">
            {sidebarCollapsed ? '⚙' : '⚙ Settings'}
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
                      : renderMarkdown(msg.content, msg.citations, handleCitationEnter, handleCitationLeave)}
                  </div>
                </div>
              ))}
              {isGenerating && !streamBuffer && (
                <div className="message message-assistant">
                  <div className="message-bubble thinking-loader">
                    <span className="thinking-spinner" />
                    <span className="thinking-label">{generateStatus || 'Thinking...'}</span>
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
        </div>

        {/* Sources panel — now on the right */}
        <div className="sources-panel">
          <div className="sources-header">Sources{sources.length > 0 ? ` · ${sources.length}` : ''}</div>
          {isReindexing && <div className="sources-progress" />}
          <div className={isReindexing ? 'sources-list reindexing' : 'sources-list'}>
            {renderTree(tree, 0, collapsedDirs, toggleDir)}
          </div>
        </div>
      </div>

      {/* Citation tooltip — rendered outside chat-body to avoid overflow clipping */}
      {activeCitation && tooltipStyle && (
        <div
          className="citation-tooltip"
          style={tooltipStyle}
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
        >
          <div className="citation-tooltip-header">
            <span className="citation-tooltip-tag">[{activeCitation.entry.sourceNum}]</span>
            <span className="citation-tooltip-file">{activeCitation.entry.chunk.sourceFile.split('/').pop()}</span>
          </div>
          <div className="citation-tooltip-body">{activeCitation.entry.chunk.text}</div>
          {(activeCitation.entry.chunk.pageNumber || activeCitation.entry.chunk.lineNumber) && (
            <div className="citation-tooltip-footer">
              {activeCitation.entry.chunk.pageNumber
                ? `p. ${activeCitation.entry.chunk.pageNumber}`
                : `L${activeCitation.entry.chunk.lineNumber}`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
