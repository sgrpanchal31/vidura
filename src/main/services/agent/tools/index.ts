// The default toolbox. New capabilities land here as tools, not as new
// pipelines. Future: load user-defined skills (name + params + prompt
// template stored as files) and register them alongside these.
import { ToolRegistry } from '../registry'
import { searchDocumentsTool } from './search-documents'
import { keywordSearchTool } from './keyword-search'
import { listFilesTool } from './list-files'
import { readFileTool } from './read-file'
import { generatePodcastTool, generateOverviewTool } from './generate'

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(searchDocumentsTool)
  registry.register(keywordSearchTool)
  registry.register(listFilesTool)
  registry.register(readFileTool)
  registry.register(generatePodcastTool)
  registry.register(generateOverviewTool)
  return registry
}
