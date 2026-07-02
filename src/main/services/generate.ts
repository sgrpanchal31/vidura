import { readFile } from 'fs/promises'
import { relative, extname } from 'path'
import { scanFolder } from './scanner'
import { parsePdf } from './ingest/pdf'
import { parseMarkdown } from './ingest/markdown'
import { parseText } from './ingest/text'
import { parseCode } from './ingest/code'
import { llamaService } from './inference'
import { getLangfuse } from './telemetry'
import { PODCAST_SCRIPT_RULES } from './podcast-script'

// Structural type — LangfuseTraceClient and LangfuseSpanClient both satisfy this
export type LangfuseParent = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  span(opts: { name: string; input?: unknown }): any
}

export type GenerateTask = 'overview' | 'podcast' | 'facts'
export type GenerateFormat = 'prose' | 'mermaid' | 'facts-json'
export type GenerateProgress = { stage: 'map' } | { stage: 'reduce' } | { stage: 'final'; type: GenerateTask }

const SYSTEM_PROMPT =
  "You are a research assistant. You read documents and produce clear, well-structured summaries and syntheses. Follow the user's formatting instructions exactly. No preamble."

// How much text to feed per document during the map phase (~1000 tokens of source)
const MAP_CHARS_PER_DOC = 4000
// How many document summaries to combine in one reduce call
const REDUCE_BATCH_SIZE = 4

function mapPrompt(task: GenerateTask, format: GenerateFormat, docSummaries: string): string {
  const formatHint =
    format === 'mermaid'
      ? 'Output valid Mermaid diagram syntax.'
      : format === 'facts-json'
        ? 'Output a JSON array of fact strings, e.g. ["Fact 1", "Fact 2"].'
        : 'Write flowing prose.'

  const taskHint: Record<GenerateTask, string> = {
    overview: 'Summarize the key ideas and structure of this document in 3–5 sentences.',
    podcast: 'Extract the main talking points and interesting details from this document.',
    facts: 'List the most important facts and claims from this document.',
  }

  return `${taskHint[task]}
${formatHint}
Be concise. Do not repeat the document title.

Document:
${docSummaries}`
}

function reducePrompt(task: GenerateTask, format: GenerateFormat, intermediates: string): string {
  const formatHint =
    format === 'mermaid'
      ? 'Output valid Mermaid diagram syntax only — no prose.'
      : format === 'facts-json'
        ? 'Output a JSON array of fact strings only — no prose.'
        : 'Write flowing prose.'

  const taskHint: Record<GenerateTask, string> = {
    overview: 'Synthesize the following document summaries into a single cohesive overview.',
    podcast:
      'Combine the following talking points into a single organized list of the best talking points for a podcast.',
    facts: 'Combine and deduplicate the following facts into a final list.',
  }

  return `${taskHint[task]}
${formatHint}

Summaries:
${intermediates}`
}

// Extract up to MAP_CHARS_PER_DOC of representative text from a file
async function extractDocText(absPath: string, ext: string): Promise<string> {
  if (ext === '.pdf') {
    const parsed = await parsePdf(absPath)
    return parsed.pages
      .map((p) => p.text)
      .join('\n\n')
      .slice(0, MAP_CHARS_PER_DOC)
  }
  const content = await readFile(absPath, 'utf-8')
  if (ext === '.md') {
    const sections = parseMarkdown(content)
    return sections
      .map((s) => s.text)
      .join('\n\n')
      .slice(0, MAP_CHARS_PER_DOC)
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb'].includes(ext)) {
    const symbols = await parseCode(absPath, content)
    if (symbols.length > 0) {
      return symbols
        .map((s) => s.parentText)
        .join('\n\n')
        .slice(0, MAP_CHARS_PER_DOC)
    }
  }
  return parseText(content).text.slice(0, MAP_CHARS_PER_DOC)
}

export async function generateFromCorpus(
  folderPath: string,
  modelId: string,
  task: GenerateTask,
  format: GenerateFormat,
  onToken: (token: string) => void,
  onProgress?: (p: GenerateProgress) => void,
  allowedFiles?: string[], // relative paths; undefined = all files
  externalTrace?: LangfuseParent | null,
  question?: string // original user question, prepended to the final synthesis prompt
): Promise<string> {
  if (!llamaService.isLoaded(modelId)) {
    await llamaService.loadModel(modelId)
  }

  const { files: allFiles } = await scanFolder(folderPath)
  const files = allowedFiles ? allFiles.filter((f) => allowedFiles.includes(relative(folderPath, f.path))) : allFiles
  if (files.length === 0) {
    const msg = 'No documents found in this notebook.'
    onToken(msg)
    return msg
  }

  const lf = getLangfuse()
  // If a parent trace is provided (chat-ask flow), attach as a child span.
  // Otherwise create a standalone trace (direct generate:run calls from Podcast tile).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelineSpan: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any
  if (externalTrace) {
    pipelineSpan = externalTrace.span({ name: 'generate-corpus', input: { task, format, fileCount: files.length } })
    trace = pipelineSpan
  } else {
    trace = lf?.trace({ name: 'generate-corpus', input: { task, format, fileCount: files.length } }) ?? null
  }

  // Map phase: summarize each document sequentially
  const intermediates: string[] = []
  for (const file of files) {
    const ext = extname(file.path).toLowerCase()
    const relPath = relative(folderPath, file.path)
    let docText: string
    try {
      docText = await extractDocText(file.path, ext)
    } catch {
      continue
    }
    if (!docText.trim()) continue

    onProgress?.({ stage: 'map' })
    const prompt = mapPrompt(task, format, `[${relPath}]\n${docText}`)
    const mapGen = trace?.generation({
      name: `map:${relPath}`,
      model: modelId,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    })
    // Silent map calls — tokens only stream during the final reduce
    const summary = await llamaService.generateStream(SYSTEM_PROMPT, prompt, () => {})
    mapGen?.update({ output: summary.slice(0, 200) })
    mapGen?.end()
    if (summary.trim()) {
      intermediates.push(`[${relPath}]\n${summary.trim()}`)
    }
  }

  if (intermediates.length === 0) {
    const msg = 'Could not extract content from any documents in this notebook.'
    trace?.update({ output: 'no_content' })
    lf?.flushAsync().catch(() => {})
    onToken(msg)
    return msg
  }

  // Reduce phase: combine intermediates, batching if needed
  onProgress?.({ stage: 'reduce' })
  let current = intermediates
  let reduceRound = 0
  while (current.length > 1) {
    const next: string[] = []
    for (let i = 0; i < current.length; i += REDUCE_BATCH_SIZE) {
      const batch = current.slice(i, i + REDUCE_BATCH_SIZE)
      if (batch.length === 1) {
        next.push(batch[0])
        continue
      }
      const prompt = reducePrompt(task, format, batch.join('\n\n---\n\n'))
      const reduceGen = trace?.generation({
        name: `reduce:r${reduceRound}:b${Math.floor(i / REDUCE_BATCH_SIZE)}`,
        model: modelId,
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      })
      const merged = await llamaService.generateStream(SYSTEM_PROMPT, prompt, () => {})
      reduceGen?.update({ output: merged.slice(0, 200) })
      reduceGen?.end()
      next.push(merged.trim())
    }
    current = next
    reduceRound++
  }

  // Final reduce — stream tokens to the caller. Podcast gets the script-format
  // rules here (not in intermediate reduces, which merge material only).
  onProgress?.({ stage: 'final', type: task })
  const basePrompt =
    task === 'podcast'
      ? `Turn the following talking points into an engaging podcast conversation.\n${PODCAST_SCRIPT_RULES}\n\nTalking points:\n${current[0]}`
      : reducePrompt(task, format, current[0])
  const finalPrompt = question ? `User request: "${question}"\n\n${basePrompt}` : basePrompt
  const finalGen = trace?.generation({
    name: 'final',
    model: modelId,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: finalPrompt },
    ],
  })
  const result = await llamaService.generateStream(SYSTEM_PROMPT, finalPrompt, onToken)
  finalGen?.update({ output: result.slice(0, 200) })
  finalGen?.end()
  trace?.update({ output: 'completed' })
  pipelineSpan?.end()
  if (!externalTrace) lf?.flushAsync().catch(() => {})
  return result
}
