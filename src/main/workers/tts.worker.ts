import { parentPort, workerData } from 'worker_threads'
import { createRequire } from 'module'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

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

type InitMsg = { type: 'init'; dtype?: string }
type SynthesizeMsg = { type: 'synthesize'; reqId: number; text: string; voice: string }
type WorkerMsg = InitMsg | SynthesizeMsg

let tts: Awaited<ReturnType<typeof KokoroTTS.from_pretrained>> | null = null

async function init(dtype: string): Promise<void> {
  // kokoro-js nests its own @huggingface/transformers whose default cache lives
  // inside node_modules (read-only when the app is packaged). Resolve that nested
  // copy (same module instance kokoro.cjs requires) and point it at our models dir.
  if (workerData?.cacheDir) {
    const kokoroRequire = createRequire(require.resolve('kokoro-js'))
    kokoroRequire('@huggingface/transformers').env.cacheDir = workerData.cacheDir
  }

  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    // cast: kokoro-js narrows dtype/device to literal unions
    dtype: dtype as never,
    device: 'cpu',
    progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
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
  parentPort!.postMessage({ type: 'ready' })
}

// Synthesize one script segment. TextSplitterStream handles Kokoro's ~510-token
// per-call limit by cutting the text at sentence boundaries internally.
async function synthesize(reqId: number, text: string, voice: string): Promise<void> {
  if (!tts) {
    parentPort!.postMessage({ type: 'error', reqId, error: 'TTS model not ready' })
    return
  }
  try {
    const splitter = new TextSplitterStream()
    const stream = tts.stream(splitter, { voice: voice as never })
    splitter.push(text)
    splitter.close()

    const chunks: Float32Array[] = []
    let sampleRate = 24000
    for await (const { audio } of stream) {
      chunks.push(audio.audio)
      sampleRate = audio.sampling_rate
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const samples = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      samples.set(c, offset)
      offset += c.length
    }
    parentPort!.postMessage({ type: 'audio', reqId, samples, sampleRate }, [samples.buffer])
  } catch (err) {
    parentPort!.postMessage({ type: 'error', reqId, error: String(err) })
  }
}

parentPort!.on('message', async (msg: WorkerMsg) => {
  if (msg.type === 'init') {
    try {
      await init(msg.dtype ?? 'q8')
    } catch (err) {
      parentPort!.postMessage({ type: 'init_error', error: String(err) })
    }
    return
  }
  if (msg.type === 'synthesize') {
    await synthesize(msg.reqId, msg.text, msg.voice)
  }
})
