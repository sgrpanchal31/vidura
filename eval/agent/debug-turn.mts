// Reproduces the agent's exact first turn (real seed retrieval, real prompts)
// and prints what the model sees and says. Isolates model comprehension from
// loop mechanics.
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import os from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..', '..')
if (!process.env.OPENBOOK_MODELS_DIR) {
  const macCache = join(os.homedir(), 'Library', 'Application Support', 'vidura', 'models')
  if (existsSync(macCache)) process.env.OPENBOOK_MODELS_DIR = macCache
}

const { retrieve, rerankChunks, dedupeByParent } = await import('../../src/main/services/rag')
const { rerankerGgufService } = await import('../../src/main/services/reranker-gguf')
const { llamaService } = await import('../../src/main/services/inference')
const { EvidenceRegistry, formatEvidenceWithinBudget } = await import('../../src/main/services/agent/evidence')
const { buildAgentSystemPrompt, buildFirstTurn, ANSWER_INSTRUCTION } = await import(
  '../../src/main/services/agent/prompts'
)
const { buildDefaultRegistry } = await import('../../src/main/services/agent/tools')

const notebookDir = join(ROOT, '.openbook', 'eval', 'agent-notebook')
const question =
  process.argv[2] ?? 'What BLEU score did the Transformer big model achieve on WMT 2014 English-to-German translation?'

await rerankerGgufService.start().catch(() => {})
await llamaService.loadModel(process.argv[3] ?? 'gemma4-e4b')

const chunks = await retrieve(question, notebookDir, { topK: 30 })
const parents = dedupeByParent(await rerankChunks(question, chunks))
const evidence = new EvidenceRegistry()
evidence.add(parents)

const registry = buildDefaultRegistry()
const systemPrompt = buildAgentSystemPrompt(registry.renderToolDocs(), [])
const firstTurn = buildFirstTurn(question, formatEvidenceWithinBudget(evidence.all(), 12_000))

console.log('=== FIRST TURN SENT TO MODEL ===')
console.log(firstTurn.slice(0, 3000))
console.log(`... (${firstTurn.length} chars total)\n`)

const grammar = await llamaService.createJsonGrammar(registry.buildDecisionSchema())
const session = await llamaService.createAgentSession(systemPrompt)
const raw = await session.promptJson(firstTurn, grammar, { maxTokens: 160 })
console.log('=== DECISION ===')
console.log(raw)

// Force the answer regardless of the decision, to see what it says from seed evidence
let answer = ''
await session.promptText(ANSWER_INSTRUCTION, { onToken: (t) => (answer += t) })
console.log('=== FORCED ANSWER FROM SEED EVIDENCE ===')
console.log(answer)
await session.dispose()
process.exit(0)
