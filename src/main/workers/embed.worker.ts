import { parentPort, workerData } from 'worker_threads'
import { pipeline } from '@huggingface/transformers'

const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'

// Catch any crash (e.g. native module failure, unhandled rejection from Transformers.js)
// and turn it into a clean init_error so the main thread resets gracefully.
process.on('uncaughtException', (err) => {
  try {
    parentPort?.postMessage({ type: 'init_error', error: String(err) })
  } catch {
    /* port may already be closed */
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    parentPort?.postMessage({ type: 'init_error', error: String(reason) })
  } catch {
    /* port may already be closed */
  }
})

type InitMsg = { type: 'init'; modelId?: string; dtype?: string; pooling?: 'mean' | 'last_token' }
type EmbedMsg = { type: 'embed'; reqId: number; texts: string[] }
type WorkerMsg = InitMsg | EmbedMsg

let extractor: Awaited<ReturnType<typeof pipeline>> | null = null
let activePooling: 'mean' | 'last_token' = 'last_token'

async function init(modelId: string, dtype: string, pooling: 'mean' | 'last_token'): Promise<void> {
  activePooling = pooling

  const pipelineOpts = (device: string) => ({
    dtype,
    device,
    cache_dir: workerData?.cacheDir ?? undefined,
    progress_callback: (p: any) => {
      // Only report progress for large files (>1MB) — small config/tokenizer files
      // download instantly and reset the bar, causing it to visually glitch.
      if (
        (p.status === 'progress' || p.status === 'download') &&
        typeof p.loaded === 'number' &&
        typeof p.total === 'number' &&
        p.total > 1_000_000
      ) {
        parentPort!.postMessage({ type: 'download_progress', loaded: p.loaded, total: p.total })
      }
    },
  })

  // CPU is the only viable execution provider: CoreML cannot handle the zero-length
  // KV-cache tensors this decoder model produces on its first forward pass.
  // cast: @huggingface/transformers narrowed device to a literal union; 'cpu' string isn't assignable
  extractor = await pipeline('feature-extraction', modelId, pipelineOpts('cpu') as any)
  parentPort!.postMessage({ type: 'device_info', device: 'cpu' })

  parentPort!.postMessage({ type: 'ready' })
}

parentPort!.on('message', async (msg: WorkerMsg) => {
  if (msg.type === 'init') {
    try {
      await init(msg.modelId ?? DEFAULT_MODEL_ID, msg.dtype ?? 'q8', msg.pooling ?? 'last_token')
    } catch (err) {
      parentPort!.postMessage({ type: 'init_error', error: String(err) })
    }
    return
  }

  if (msg.type === 'embed') {
    if (!extractor) {
      parentPort!.postMessage({ type: 'error', reqId: msg.reqId, error: 'Extractor not ready' })
      return
    }
    try {
      // cast: extractor is a union of 27+ pipeline types; TS can't unify their call signatures
      const output = await (extractor as any)(msg.texts, { pooling: activePooling, normalize: true })
      const batchSize: number = output.dims[0]
      const dim: number = output.dims[1]
      const vectors: number[][] = []
      for (let i = 0; i < batchSize; i++) {
        vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)) as number[])
      }
      parentPort!.postMessage({ type: 'embeddings', reqId: msg.reqId, vectors })
    } catch (err) {
      parentPort!.postMessage({ type: 'error', reqId: msg.reqId, error: String(err) })
    }
  }
})
