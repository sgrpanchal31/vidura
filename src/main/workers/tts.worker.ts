import { createRequire } from 'module'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

// This file runs in an Electron utilityProcess (a separate OS process), NOT a
// worker thread. kokoro-js ships its own onnxruntime native library which
// segfaults if it shares a process with the embedding engine's different
// onnxruntime version — process isolation is what keeps the app alive.
const port = process.parentPort

// Catch any crash (e.g. native module failure, unhandled rejection from Transformers.js)
// and turn it into a clean init_error so the main process resets gracefully.
process.on('uncaughtException', (err) => {
  try {
    port.postMessage({ type: 'init_error', error: String(err) })
  } catch {
    /* port may already be closed */
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    port.postMessage({ type: 'init_error', error: String(reason) })
  } catch {
    /* port may already be closed */
  }
})

type InitMsg = { type: 'init'; dtype?: string; cacheDir?: string }
type SynthesizeMsg = { type: 'synthesize'; reqId: number; text: string; voice: string }
type WorkerMsg = InitMsg | SynthesizeMsg

let tts: Awaited<ReturnType<typeof KokoroTTS.from_pretrained>> | null = null

async function init(dtype: string, cacheDir?: string): Promise<void> {
  // kokoro-js nests its own @huggingface/transformers whose default cache lives
  // inside node_modules (read-only when the app is packaged). Resolve that nested
  // copy (same module instance kokoro.cjs requires) and point it at our models dir.
  if (cacheDir) {
    const kokoroRequire = createRequire(require.resolve('kokoro-js'))
    kokoroRequire('@huggingface/transformers').env.cacheDir = cacheDir
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
        port.postMessage({ type: 'download_progress', loaded: p.loaded, total: p.total })
      }
    },
  })
  port.postMessage({ type: 'ready' })
}

// Synthesize one script segment. TextSplitterStream handles Kokoro's ~510-token
// per-call limit by cutting the text at sentence boundaries internally.
async function synthesize(reqId: number, text: string, voice: string): Promise<void> {
  if (!tts) {
    port.postMessage({ type: 'error', reqId, error: 'TTS model not ready' })
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
    // Structured clone copies the samples across the process boundary; a few MB
    // per segment is fine (utilityProcess ports cannot transfer ArrayBuffers).
    port.postMessage({ type: 'audio', reqId, samples, sampleRate })
  } catch (err) {
    port.postMessage({ type: 'error', reqId, error: String(err) })
  }
}

// utilityProcess message events wrap the payload: the message is in e.data
port.on('message', async (e: Electron.MessageEvent) => {
  const msg = e.data as WorkerMsg
  if (msg.type === 'init') {
    try {
      await init(msg.dtype ?? 'q8', msg.cacheDir)
    } catch (err) {
      port.postMessage({ type: 'init_error', error: String(err) })
    }
    return
  }
  if (msg.type === 'synthesize') {
    await synthesize(msg.reqId, msg.text, msg.voice)
  }
})
