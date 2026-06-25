import { join } from 'path'
import { existsSync } from 'fs'
import os from 'os'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipe: any = null

export const EVAL_EMBEDDING_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
export const EVAL_EMBEDDING_DIM = 1024

// Qwen3-Embedding is asymmetric: queries must carry a task instruction, docs are embedded as-is.
const QUERY_PREFIX = "Instruct: Given a question, retrieve passages from the user's documents that answer it\nQuery: "

// Try the Electron app's userData cache first so we reuse the already-downloaded model.
function resolveModelCacheDir(): string {
  if (process.env.OPENBOOK_MODELS_DIR) return process.env.OPENBOOK_MODELS_DIR
  if (process.platform === 'darwin') {
    const macPath = join(os.homedir(), 'Library', 'Application Support', 'openbook-lm', 'models')
    if (existsSync(macPath)) return macPath
  }
  return join(os.homedir(), '.openbook', 'models')
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!pipe) {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = resolveModelCacheDir()
    pipe = await pipeline('feature-extraction', EVAL_EMBEDDING_MODEL, { dtype: 'q8' })
    console.log(`  [embedder] model ready: ${EVAL_EMBEDDING_MODEL} (cache: ${env.cacheDir})`)
  }

  const results: number[][] = []
  for (const text of texts) {
    const out = await pipe(text, { pooling: 'last_token', normalize: true })
    results.push(Array.from(out.data as Float32Array))
  }
  return results
}

export async function embedQuery(query: string): Promise<number[]> {
  const [vec] = await embedTexts([QUERY_PREFIX + query])
  return vec
}
