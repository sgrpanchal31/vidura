// Reads a file's indexed content in order, one window at a time — how the
// agent handles "summarize X" or digs into a file a search surfaced. This is
// the retrieval half of the old ragSummarizeFile, reborn as a tool.
//
// GBNF grammars can't express optional params, so start_chunk is required:
// 0 means "from the beginning", and the result tells the model what value to
// pass to continue reading.
import { vectorStore } from '../../store'
import { DEFAULT_EMBED, embedDim } from '../../embed-models'
import { dedupeByParent } from '../../rag'
import { formatEvidence } from '../evidence'
import { resolveFile } from './resolve-file'
import type { AgentTool, ToolResult, AgentContext } from '../types'

// Per-call content budget. A window of parents adding up to ~3k chars keeps
// one read_file from flooding the 8k-token context.
const WINDOW_CHARS = 3_000

export const readFileTool: AgentTool = {
  name: 'read_file',
  description:
    'Read a file in order, one window at a time. Set start_chunk to 0 to begin; the result says which start_chunk continues. Use the exact file path.',
  kind: 'observation',
  parameters: {
    file: { type: 'string' },
    start_chunk: { type: 'integer' },
  },
  async execute(params, ctx: AgentContext): Promise<ToolResult> {
    const requested = String(params.file ?? '')
    const startChunk = Math.max(0, Number(params.start_chunk ?? 0))

    await vectorStore.open(ctx.folderPath, { dim: embedDim(DEFAULT_EMBED) })
    let files = await vectorStore.listSourceFiles()
    if (ctx.allowedFiles) files = files.filter((f) => ctx.allowedFiles!.includes(f))

    // Small models hallucinate file names (seen in the smoke test), so match
    // generously: exact → case-insensitive → basename → substring.
    const file = resolveFile(requested, files)
    if (!file) {
      const closest = files.slice(0, 10)
      return {
        llmText: `No file named "${requested}". Files available:\n${closest.map((f) => `- ${f}`).join('\n')}`,
        evidence: [],
        uiSummary: `File not found: ${requested}`,
        isError: true,
      }
    }

    const chunks = await vectorStore.getChunksByFile(file)
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
    const parents = dedupeByParent(chunks)

    // Window: parents from startChunk until the char budget is spent.
    const window: typeof parents = []
    let used = 0
    let next = startChunk
    for (let i = startChunk; i < parents.length; i++) {
      const len = parents[i].parentText.length
      if (window.length > 0 && used + len > WINDOW_CHARS) break
      window.push(parents[i])
      used += len
      next = i + 1
    }

    if (window.length === 0) {
      return {
        llmText: `${file} has ${parents.length} sections; start_chunk ${startChunk} is past the end.`,
        evidence: [],
        uiSummary: 'Past end of file',
        isError: true,
      }
    }

    // entries = the window with stable [N]s (re-reads keep old numbers);
    // added = only newly registered ones (what this call contributed).
    const { entries, added } = ctx.evidence.add(window)
    const remaining =
      next < parents.length
        ? `\n\n…more content follows. Call read_file with start_chunk ${next} to continue (${parents.length - next} of ${parents.length} sections left).`
        : ''

    return {
      llmText: formatEvidence(entries) + remaining,
      evidence: added,
      uiSummary: `Read ${file} (sections ${startChunk + 1}–${next} of ${parents.length})`,
    }
  },
}
