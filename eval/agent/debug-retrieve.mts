// One-off: what does seed retrieval actually return for a question, and
// where does the expected fact sit inside the parent text?
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

const notebookDir = join(ROOT, '.openbook', 'eval', 'agent-notebook')
const question = process.argv[2] ?? 'What BLEU score did the Transformer big model achieve on WMT 2014 English-to-German translation?'
const needle = process.argv[3] ?? '28.4'

await rerankerGgufService.start().catch(() => console.log('(no reranker)'))
const chunks = await retrieve(question, notebookDir, { topK: 30 })
const parents = dedupeByParent(await rerankChunks(question, chunks))
console.log(`retrieved ${chunks.length} chunks → ${parents.length} parents`)
parents.forEach((p, i) => {
  const pos = p.parentText.indexOf(needle)
  console.log(
    `[${i + 1}] ${p.sourceFile} parentLen=${p.parentText.length} needleAt=${pos} ${pos >= 0 && pos < 1500 ? '(within 1500 cap)' : pos >= 1500 ? '(TRUNCATED by cap!)' : ''}`
  )
})
process.exit(0)
