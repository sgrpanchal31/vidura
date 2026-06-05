import { join } from 'path'
import os from 'os'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipe: any = null

export const EVAL_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'
export const EVAL_EMBEDDING_DIM = 384

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!pipe) {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = process.env.OPENBOOK_MODELS_DIR ?? join(os.homedir(), '.openbook', 'models')
    pipe = await pipeline('feature-extraction', EVAL_EMBEDDING_MODEL, { dtype: 'q8' })
    console.log(`  [embedder] model ready: ${EVAL_EMBEDDING_MODEL}`)
  }

  const results: number[][] = []
  for (const text of texts) {
    const out = await pipe(text, { pooling: 'mean', normalize: true })
    results.push(Array.from(out.data as Float32Array))
  }
  return results
}

export async function embedQuery(query: string): Promise<number[]> {
  const [vec] = await embedTexts([query])
  return vec
}
