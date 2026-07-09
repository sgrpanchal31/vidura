import { Worker } from 'worker_threads'
import { join } from 'path'
import os from 'os'
import { DEFAULT_EMBED, EMBED_REGISTRY } from './embed-models'

const BATCH_SIZE = 1
// Number of stderr lines to keep as a rolling tail for crash diagnostics
const STDERR_TAIL = 20

type PendingRequest = {
  resolve: (vectors: number[][]) => void
  reject: (err: Error) => void
}

export class EmbedService {
  private worker: Worker | null = null
  private started = false
  private currentModelId: string | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady!: () => void
  private rejectReady!: (e: Error) => void
  private pending = new Map<number, PendingRequest>()
  private nextId = 0

  async start(
    onDownloadProgress?: (loaded: number, total: number) => void,
    opts?: { cacheDir?: string; modelId?: string }
  ): Promise<void> {
    const requestedModel = opts?.modelId ?? DEFAULT_EMBED
    const entry = EMBED_REGISTRY[requestedModel] ?? EMBED_REGISTRY[DEFAULT_EMBED]

    // If already started with the same model, nothing to do
    if (this.started && this.currentModelId === requestedModel) return

    // If started with a different model, tear down the old worker first
    if (this.started) this.stop()

    this.started = true
    this.currentModelId = requestedModel

    this.readyPromise = new Promise<void>((res, rej) => {
      this.resolveReady = res
      this.rejectReady = rej
    })

    const workerPath = join(__dirname, 'workers', 'embed.worker.js')

    let cacheDir: string
    if (opts?.cacheDir) {
      cacheDir = opts.cacheDir
    } else if (process.versions.electron) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cacheDir = join(require('electron').app.getPath('userData'), 'models')
    } else {
      cacheDir = process.env.OPENBOOK_MODELS_DIR ?? join(os.homedir(), '.openbook', 'models')
    }

    // Capture stderr so genuine onnxruntime crashes surface in the error message
    const worker = new Worker(workerPath, { workerData: { cacheDir }, stderr: true })
    this.worker = worker

    // Rolling stderr tail — piped to process.stderr so it shows in the dev console too
    const stderrLines: string[] = []
    let stderrBuf = ''
    worker.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      process.stderr.write(text)
      stderrBuf += text
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        stderrLines.push(line)
        if (stderrLines.length > STDERR_TAIL) stderrLines.shift()
      }
    })

    const makeError = (base: string) => {
      const tail = stderrLines
        .filter((l) => l.trim())
        .slice(-8)
        .join('\n')
      return new Error(tail ? `${base}\n${tail}` : base)
    }

    worker.on('message', (msg: any) => {
      // Ignore events from a stale/replaced worker
      if (this.worker !== worker) return

      if (msg.type === 'device_info') {
        console.log(`[embed] running on ${msg.device === 'gpu' ? 'GPU/CoreML' : 'CPU'}`)
      } else if (msg.type === 'ready') {
        this.resolveReady()
      } else if (msg.type === 'init_error') {
        const error = new Error(msg.error)
        this.started = false
        this.currentModelId = null
        this.worker = null
        worker.terminate()
        this.rejectReady(error)
      } else if (msg.type === 'download_progress') {
        onDownloadProgress?.(msg.loaded, msg.total)
      } else if (msg.type === 'embeddings') {
        const req = this.pending.get(msg.reqId)
        if (req) {
          this.pending.delete(msg.reqId)
          req.resolve(msg.vectors)
        }
      } else if (msg.type === 'error') {
        const req = this.pending.get(msg.reqId)
        if (req) {
          this.pending.delete(msg.reqId)
          req.reject(new Error(msg.error))
        }
      }
    })

    worker.on('error', (err) => {
      if (this.worker !== worker) return
      this.started = false
      this.currentModelId = null
      this.worker = null
      const wrapped = makeError(err.message)
      this.rejectReady(wrapped)
      for (const req of this.pending.values()) req.reject(wrapped)
      this.pending.clear()
    })

    worker.on('exit', (code) => {
      // Ignore exits from workers we already replaced or deliberately stopped
      if (this.worker !== worker) return
      if (code !== 0) {
        const err = makeError(`Embed worker exited unexpectedly (code ${code})`)
        this.started = false
        this.currentModelId = null
        this.worker = null
        this.rejectReady(err)
        for (const req of this.pending.values()) req.reject(err)
        this.pending.clear()
      }
    })

    worker.postMessage({
      type: 'init',
      modelId: requestedModel,
      dtype: entry?.dtype ?? 'q4',
      pooling: entry?.pooling ?? 'last_token',
    })
    await this.readyPromise
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    await this.readyPromise
    const reqId = this.nextId++
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.worker!.postMessage({ type: 'embed', reqId, texts })
    })
  }

  async embedBatched(texts: string[], onBatch?: (done: number, total: number) => void): Promise<number[][]> {
    if (!this.started) await this.start()
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE)
      const vecs = await this.embedBatch(batch)
      results.push(...vecs)
      onBatch?.(Math.min(i + BATCH_SIZE, texts.length), texts.length)
    }
    return results
  }

  isStarted(): boolean {
    return this.started
  }

  async stop(): Promise<void> {
    const worker = this.worker
    // Null this.worker BEFORE terminate() so the exit handler's guard ignores the event
    this.worker = null
    this.started = false
    this.currentModelId = null
    this.readyPromise = null
    this.pending.clear()
    await worker?.terminate()
  }
}

export const embedService = new EmbedService()
