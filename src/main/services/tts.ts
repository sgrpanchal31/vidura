import { Worker } from 'worker_threads'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import os from 'os'
import { parsePodcastScript } from './podcast-script'
import { encodeWavPcm16, concatFloat32 } from './wav'

// Voice assignment. af_heart is Kokoro's highest-quality voice (grade A);
// am_fenrir is the most energetic male. Swap to am_michael if fenrir sounds off.
const VOICE_A = 'af_heart'
const VOICE_B = 'am_fenrir'
const VOICE_SOLO = 'af_heart'

// Number of stderr lines to keep as a rolling tail for crash diagnostics
const STDERR_TAIL = 20

export type MessageAudio = {
  file: string // relative to notebook folder, e.g. .openbook/audio/<session>-<message>.wav
  durationSec: number
  chapters: Array<{ title: string; startSec: number }>
}

export type TtsProgress =
  | { stage: 'model_download'; loaded: number; total: number }
  | { stage: 'loading' }
  | { stage: 'synthesizing'; done: number; total: number }
  | { stage: 'writing' }

// Thrown when a job is cancelled; callers treat it as silence, not an error
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

// The engine seam: a future ChatterboxEngine implements these three methods
// and nothing else in the pipeline changes.
export interface TtsEngine {
  start(onProgress: (p: TtsProgress) => void): Promise<void>
  synthesize(text: string, voice: string): Promise<{ samples: Float32Array; sampleRate: number }>
  stop(): void
}

type PendingRequest = {
  resolve: (result: { samples: Float32Array; sampleRate: number }) => void
  reject: (err: Error) => void
}

// Kokoro-82M running in a worker thread (same lifecycle as EmbedService)
class KokoroEngine implements TtsEngine {
  private worker: Worker | null = null
  private readyPromise: Promise<void> | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 0

  async start(onProgress: (p: TtsProgress) => void): Promise<void> {
    if (this.worker) return
    onProgress({ stage: 'loading' })

    let resolveReady!: () => void
    let rejectReady!: (e: Error) => void
    this.readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })

    let cacheDir: string
    if (process.versions.electron) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cacheDir = join(require('electron').app.getPath('userData'), 'models')
    } else {
      cacheDir = process.env.OPENBOOK_MODELS_DIR ?? join(os.homedir(), '.openbook', 'models')
    }

    const workerPath = join(__dirname, 'workers', 'tts.worker.js')
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

    const failAll = (err: Error) => {
      this.worker = null
      this.readyPromise = null
      rejectReady(err)
      for (const req of this.pending.values()) req.reject(err)
      this.pending.clear()
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on('message', (msg: any) => {
      if (this.worker !== worker) return
      if (msg.type === 'download_progress') {
        onProgress({ stage: 'model_download', loaded: msg.loaded, total: msg.total })
      } else if (msg.type === 'ready') {
        resolveReady()
      } else if (msg.type === 'init_error') {
        worker.terminate()
        failAll(new Error(msg.error))
      } else if (msg.type === 'audio') {
        const req = this.pending.get(msg.reqId)
        if (req) {
          this.pending.delete(msg.reqId)
          req.resolve({ samples: msg.samples, sampleRate: msg.sampleRate })
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
      failAll(makeError(err.message))
    })

    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      if (code !== 0) failAll(makeError(`TTS worker exited unexpectedly (code ${code})`))
    })

    worker.postMessage({ type: 'init', dtype: 'q8' })
    await this.readyPromise
  }

  async synthesize(text: string, voice: string): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.worker || !this.readyPromise) throw new Error('TTS engine not started')
    await this.readyPromise
    const reqId = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.worker!.postMessage({ type: 'synthesize', reqId, text, voice })
    })
  }

  stop(): void {
    const worker = this.worker
    // Null this.worker BEFORE terminate() so the exit handler's guard ignores the event
    this.worker = null
    this.readyPromise = null
    this.pending.clear()
    worker?.terminate()
  }
}

type SynthesizeOpts = {
  script: string
  folderPath: string
  sessionId: string
  messageId: string
  onProgress: (p: TtsProgress) => void
}

export class TtsService {
  private engine: TtsEngine = new KokoroEngine()
  private queue: Promise<void> = Promise.resolve()
  private activeJobs = new Map<string, { cancelled: boolean }>() // sessionId -> flag
  private queuedCount = 0

  async synthesizePodcast(opts: SynthesizeOpts): Promise<MessageAudio> {
    const job = { cancelled: false }
    this.activeJobs.set(opts.sessionId, job)
    this.queuedCount++

    // Serialize jobs on a promise chain — one synthesis at a time
    const run = this.queue.then(() => this.runJob(opts, job))
    this.queue = run.then(
      () => {},
      () => {}
    )
    try {
      return await run
    } finally {
      this.queuedCount--
      if (this.activeJobs.get(opts.sessionId) === job) this.activeJobs.delete(opts.sessionId)
      // Free the worker's memory (~300-500MB) once nothing is waiting;
      // reloading from disk cache on the next podcast takes only a couple of seconds
      if (this.queuedCount === 0) this.engine.stop()
    }
  }

  private async runJob(opts: SynthesizeOpts, job: { cancelled: boolean }): Promise<MessageAudio> {
    if (job.cancelled) throw new CancelledError()

    const { segments, chapters } = parsePodcastScript(opts.script)
    if (segments.length === 0) throw new Error('The script contained no readable text.')

    await this.engine.start(opts.onProgress)

    const audioChunks: Float32Array[] = []
    const chapterTimes: Array<{ title: string; startSec: number }> = []
    let sampleRate = 24000
    let cumulativeSamples = 0

    for (let i = 0; i < segments.length; i++) {
      if (job.cancelled) throw new CancelledError()
      // Chapters whose section starts at this segment get the current timestamp
      for (const ch of chapters) {
        if (ch.segmentIndex === i) chapterTimes.push({ title: ch.title, startSec: cumulativeSamples / sampleRate })
      }
      const seg = segments[i]
      const voice = seg.speaker === 'A' ? VOICE_A : seg.speaker === 'B' ? VOICE_B : VOICE_SOLO
      const result = await this.engine.synthesize(seg.text, voice)
      sampleRate = result.sampleRate
      audioChunks.push(result.samples)
      cumulativeSamples += result.samples.length
      opts.onProgress({ stage: 'synthesizing', done: i + 1, total: segments.length })
    }

    if (job.cancelled) throw new CancelledError()
    opts.onProgress({ stage: 'writing' })

    const audioDir = join(opts.folderPath, '.openbook', 'audio')
    await mkdir(audioDir, { recursive: true })
    const filename = `${opts.sessionId}-${opts.messageId}.wav`
    await writeFile(join(audioDir, filename), encodeWavPcm16(concatFloat32(audioChunks), sampleRate))

    return {
      file: join('.openbook', 'audio', filename),
      durationSec: cumulativeSamples / sampleRate,
      chapters: chapterTimes,
    }
  }

  cancel(sessionId: string): void {
    const job = this.activeJobs.get(sessionId)
    if (job) job.cancelled = true
  }

  stop(): void {
    for (const job of this.activeJobs.values()) job.cancelled = true
    this.engine.stop()
  }
}

export const ttsService = new TtsService()
