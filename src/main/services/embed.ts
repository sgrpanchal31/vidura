import { Worker } from 'worker_threads'
import { join } from 'path'
import { app } from 'electron'

const BATCH_SIZE = 32

type PendingRequest = {
  resolve: (vectors: number[][]) => void
  reject: (err: Error) => void
}

export class EmbedService {
  private worker: Worker | null = null
  private started = false
  private readyPromise: Promise<void> | null = null
  private resolveReady!: () => void
  private rejectReady!: (e: Error) => void
  private pending = new Map<number, PendingRequest>()
  private nextId = 0

  async start(onDownloadProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.started) return
    this.started = true

    this.readyPromise = new Promise<void>((res, rej) => {
      this.resolveReady = res
      this.rejectReady = rej
    })

    const workerPath = join(__dirname, 'workers', 'embed.worker.js')
    const cacheDir = join(app.getPath('userData'), 'models')

    this.worker = new Worker(workerPath, { workerData: { cacheDir } })

    this.worker.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        this.resolveReady()
      } else if (msg.type === 'init_error') {
        this.rejectReady(new Error(msg.error))
      } else if (msg.type === 'download_progress') {
        onDownloadProgress?.(msg.loaded, msg.total)
      } else if (msg.type === 'embeddings') {
        const req = this.pending.get(msg.reqId)
        if (req) { this.pending.delete(msg.reqId); req.resolve(msg.vectors) }
      } else if (msg.type === 'error') {
        const req = this.pending.get(msg.reqId)
        if (req) { this.pending.delete(msg.reqId); req.reject(new Error(msg.error)) }
      }
    })

    this.worker.on('error', (err) => {
      this.rejectReady(err)
      for (const req of this.pending.values()) req.reject(err)
      this.pending.clear()
    })

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`Embed worker exited unexpectedly (code ${code})`)
        this.rejectReady(err)
        for (const req of this.pending.values()) req.reject(err)
        this.pending.clear()
      }
    })

    this.worker.postMessage({ type: 'init' })
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

  async embedBatched(
    texts: string[],
    onBatch?: (done: number, total: number) => void
  ): Promise<number[][]> {
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

  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.started = false
    this.readyPromise = null
    this.pending.clear()
  }
}

export const embedService = new EmbedService()
