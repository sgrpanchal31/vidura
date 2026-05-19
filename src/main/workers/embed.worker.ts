import { parentPort, workerData } from 'worker_threads'
import { pipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/bge-small-en-v1.5'
const EMBEDDING_DIM = 384

type InitMsg  = { type: 'init' }
type EmbedMsg = { type: 'embed'; reqId: number; texts: string[] }
type WorkerMsg = InitMsg | EmbedMsg

let extractor: Awaited<ReturnType<typeof pipeline>> | null = null

async function init(): Promise<void> {
  extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    // cache_dir: userData/models — keeps downloaded models in a predictable location
    cache_dir: workerData?.cacheDir ?? undefined,
    progress_callback: (p: any) => {
      // Forward file-level download progress to the main thread
      if (p.status === 'progress' && typeof p.loaded === 'number' && typeof p.total === 'number') {
        parentPort!.postMessage({ type: 'download_progress', loaded: p.loaded, total: p.total })
      }
    }
  })
  parentPort!.postMessage({ type: 'ready' })
}

parentPort!.on('message', async (msg: WorkerMsg) => {
  if (msg.type === 'init') {
    try {
      await init()
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
      const output = await extractor(msg.texts, { pooling: 'mean', normalize: true }) as any
      const batchSize: number = output.dims[0]
      const dim: number = output.dims[1] ?? EMBEDDING_DIM
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
