// Smoke test for the agent loop's riskiest unknown: does grammar-constrained
// JSON decoding work at runtime on our models (Gemma 4 uses SWA + swaFullCache)?
// Runs headless — no Electron, no vector store. The "tools" are stubs with the
// real schemas; what's under test is grammar creation, decision decoding,
// thought quality, and the constrained→unconstrained turn switch on one session.
//
// Run: npx tsx eval/agent/smoke.ts [modelFile]   (default gemma4-e4b.gguf)
import { getLlama, LlamaChatSession } from 'node-llama-cpp'
import { join } from 'path'
import { homedir } from 'os'
import { ToolRegistry } from '../../src/main/services/agent/registry'
import { buildAgentSystemPrompt, buildFirstTurn, buildObservationTurn, ANSWER_INSTRUCTION } from '../../src/main/services/agent/prompts'
import type { AgentTool } from '../../src/main/services/agent/types'

const MODELS_DIR = join(homedir(), 'Library/Application Support/vidura/models')
const modelFile = process.argv[2] ?? 'gemma4-e4b.gguf'

// Same names/params/descriptions as the real tools, stub execute (not called here).
const stub = (name: string, description: string, parameters: AgentTool['parameters']): AgentTool => ({
  name,
  description,
  parameters,
  kind: 'observation',
  execute: async () => ({ llmText: '', evidence: [], uiSummary: '' }),
})

const registry = new ToolRegistry()
registry.register(
  stub(
    'search_documents',
    'Search the documents by meaning. Finds passages related to the query even when the wording differs. Use a short, specific query.',
    { query: { type: 'string' } }
  )
)
registry.register(
  stub('read_file', 'Read a file from the start. Use start_chunk 0 to begin at the top.', {
    file: { type: 'string' },
    start_chunk: { type: 'integer' },
  })
)

const FAKE_EVIDENCE = `[1] From attention.pdf p.8 § Results:
The Transformer (big) model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results by over 2 BLEU.

[2] From bert.pdf p.3 § Introduction:
BERT obtains new state-of-the-art results on eleven natural language processing tasks, including pushing the GLUE score to 80.5%.`

async function main(): Promise<void> {
  console.log(`Model: ${modelFile}`)
  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath: join(MODELS_DIR, modelFile) })

  const t0 = Date.now()
  const grammar = await llama.createGrammarForJsonSchema(registry.buildDecisionSchema() as never)
  console.log(`Grammar compiled in ${Date.now() - t0}ms`)

  const context = await model.createContext({ contextSize: 8192, swaFullCache: true })
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: buildAgentSystemPrompt(registry.renderToolDocs(), []),
  })

  const decide = async (label: string, turnText: string): Promise<Record<string, unknown>> => {
    const t = Date.now()
    const raw = await session.prompt(turnText, { grammar, maxTokens: 160 })
    console.log(`\n--- ${label} (${Date.now() - t}ms) ---\n${raw}`)
    const parsed = JSON.parse(raw) // grammar should guarantee this never throws
    if (typeof parsed.action !== 'string') throw new Error('missing action')
    return parsed
  }

  // Case 1: evidence already covers the question → should pick "answer" (fast path)
  const d1 = await decide(
    'simple question, evidence sufficient',
    buildFirstTurn('What BLEU score does the Transformer achieve on English-to-German?', FAKE_EVIDENCE)
  )
  console.log(d1.action === 'answer' ? 'PASS: answered from seed' : `NOTE: chose ${d1.action} instead of answer`)

  // Case 2: evidence does NOT cover the question → should pick a tool
  const d2 = await decide(
    'question not covered by evidence',
    buildFirstTurn('What optimizer and learning rate schedule does RoBERTa use during pretraining?', FAKE_EVIDENCE)
  )
  console.log(d2.action !== 'answer' ? `PASS: chose tool ${d2.action}` : 'NOTE: answered without evidence')

  // Case 3: observation turn, then constrained→unconstrained switch on the same session
  await decide(
    'after an empty tool result',
    buildObservationTurn('search_documents', 'No matches. Try different words, or answer from the evidence you have.')
  )

  const t1 = Date.now()
  let answer = ''
  await session.prompt(ANSWER_INSTRUCTION, {
    maxTokens: 512,
    onTextChunk: (t) => {
      answer += t
    },
  })
  console.log(`\n--- final answer, unconstrained (${Date.now() - t1}ms) ---\n${answer}`)
  console.log(/\[\d+\]/.test(answer) ? 'PASS: answer contains [N] citations' : 'NOTE: no citations in answer')

  await context.dispose()
  console.log('\nSmoke test completed.')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err)
  process.exit(1)
})
