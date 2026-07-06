// Lists the indexed files so the model can discover what exists before
// reading or searching a specific one. Registers no evidence.
import { vectorStore } from '../../store'
import { DEFAULT_EMBED, embedDim } from '../../embed-models'
import type { AgentTool, ToolResult, AgentContext } from '../types'

// Same cap the old router used for its file listing.
const MAX_FILES = 100

export const listFilesTool: AgentTool = {
  name: 'list_files',
  description: 'List the files in the notebook. Use before read_file if you are unsure of exact file names.',
  kind: 'observation',
  parameters: {},
  async execute(_params, ctx: AgentContext): Promise<ToolResult> {
    await vectorStore.open(ctx.folderPath, { dim: embedDim(DEFAULT_EMBED) })
    let files = await vectorStore.listSourceFiles()
    if (ctx.allowedFiles) files = files.filter((f) => ctx.allowedFiles!.includes(f))
    files.sort()

    if (files.length === 0) {
      return { llmText: 'No files are indexed.', evidence: [], uiSummary: 'No files', isError: true }
    }

    const shown = files.slice(0, MAX_FILES)
    const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : ''
    return {
      llmText: `Files in the notebook:\n${shown.map((f) => `- ${f}`).join('\n')}${more}`,
      evidence: [],
      uiSummary: `Listed ${files.length} file${files.length === 1 ? '' : 's'}`,
    }
  },
}
