// Deliverable tools: podcast and overview generation. Unlike observation
// tools, these change the run's goal — picking one switches the loop into
// research mode (gather material with the observation tools), and the run
// ends by rendering a script/overview from the evidence instead of answering.
//
// execute() is intentionally never called: the orchestrator handles the mode
// switch and the render itself — see runAgent() in orchestrator.ts.
import type { AgentTool } from '../types'

const neverCalled = async (): Promise<never> => {
  throw new Error('Deliverable tools are dispatched by chat:ask, not executed in-loop')
}

// GBNF grammars can't express optional params, so "files" is required:
// [] means all files. The prompt docs below tell the model that.
export const generatePodcastTool: AgentTool = {
  name: 'generate_podcast',
  description:
    'Create a podcast from the documents. ONLY when the user explicitly asks for a podcast. "files": which files to base it on, [] for all. "mode": "duo" for two hosts (the default), "solo" only if the user wants a single narrator.',
  kind: 'deliverable',
  parameters: {
    files: { type: 'array', items: { type: 'string' } },
    mode: { enum: ['duo', 'solo'] },
  },
  execute: neverCalled,
}

export const generateOverviewTool: AgentTool = {
  name: 'generate_overview',
  description:
    'Write a structured overview by reading files fully. ONLY when the user asks to summarize whole documents or everything. "files": which files to summarize, [] for all. For ordinary questions, use search and answer instead.',
  kind: 'deliverable',
  parameters: {
    files: { type: 'array', items: { type: 'string' } },
  },
  execute: neverCalled,
}
