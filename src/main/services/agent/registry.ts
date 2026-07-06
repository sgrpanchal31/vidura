// ToolRegistry: holds the tools and builds the two artifacts the loop needs
// from them — the decision grammar schema (what the model CAN say) and the
// tool docs block (what the model is TOLD it can do). Tools are registered at
// startup today, but nothing here assumes that: definitions could come from
// user files later (skills-as-tools).
import type { GbnfJsonSchema } from 'node-llama-cpp'
import type { AgentTool } from './types'

// Every decision carries a short visible thought. Capped by the grammar
// itself so a small model physically cannot ramble; the system prompt must
// mention the length expectation (node-llama-cpp docs: unstated caps cause
// hallucinations).
export const THOUGHT_MAX_CHARS = 200

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  list(): AgentTool[] {
    return [...this.tools.values()]
  }

  // The decision schema: a oneOf where each branch is one tool call (or the
  // terminal "answer"). Sampled under a grammar, so the model's output always
  // parses and always names a real tool with the right param types.
  // Property order matters: thought comes first so the model reasons before
  // it picks — the JSON is generated left to right.
  buildDecisionSchema(): GbnfJsonSchema {
    const thought = { type: 'string' as const, maxLength: THOUGHT_MAX_CHARS }
    const branches: GbnfJsonSchema[] = this.list().map((tool) => ({
      type: 'object' as const,
      properties: {
        thought,
        action: { const: tool.name },
        ...tool.parameters,
      },
    }))
    branches.push({
      type: 'object' as const,
      properties: { thought, action: { const: 'answer' } },
    })
    return { oneOf: branches }
  }

  // The system-prompt block describing each action. Grammar schemas aren't
  // shown to the model, so this text is its only documentation of the tools.
  renderToolDocs(): string {
    const lines = this.list().map((tool) => {
      const params = Object.keys(tool.parameters)
        .map((p) => `"${p}"`)
        .join(', ')
      return `- "${tool.name}" (params: ${params || 'none'}): ${tool.description}`
    })
    lines.push('- "answer" (params: none): stop searching and write the final answer from the evidence.')
    return lines.join('\n')
  }
}
