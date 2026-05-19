import { join } from 'path'
import { app, net } from 'electron'
import { existsSync, createWriteStream, mkdirSync } from 'fs'
import { stat, unlink, open as fsOpen } from 'fs/promises'

const MODELS_DIR = join(app.getPath('userData'), 'models')

// A file is only "downloaded" if it's at least this fraction of the expected size.
// Catches partial downloads that were interrupted mid-stream.
const COMPLETE_THRESHOLD = 0.95

// GGUF magic bytes: ASCII "GGUF" at offset 0
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii')

type ModelEntry = {
  filename: string
  // HuggingFace /resolve/main/ URLs — Electron net follows CDN redirects automatically.
  // NOTE: gemma2-2b uses the Qwen2.5-1.5B GGUF because Gemma 2 requires HF auth (gated model).
  url: string
  sizeBytes: number
}

// Sizes are approximate Q4_K_M bytes used for progress %. Server Content-Range overrides.
const REGISTRY: Record<string, ModelEntry> = {
  'gemma2-2b': {
    filename: 'gemma2-2b.gguf',
    // Replaces gated Gemma 2 2B with Qwen 2.5 1.5B (comparable size, fully open, Apache-2.0).
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 986_710_016,
  },
  'llama3.2-3b': {
    filename: 'llama3.2-3b.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_019_377_152,
  },
  'qwen2.5-7b': {
    filename: 'qwen2.5-7b.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf',
    sizeBytes: 4_685_701_120,
  },
  'phi3-mini': {
    filename: 'phi3-mini.gguf',
    url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    sizeBytes: 2_175_945_728,
  },
}

function ensureModelsDir(): void {
  mkdirSync(MODELS_DIR, { recursive: true })
}

export function getModelPath(modelId: string): string {
  ensureModelsDir()
  const entry = REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model ID: ${modelId}`)
  return join(MODELS_DIR, entry.filename)
}

async function hasGgufMagic(filePath: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof fsOpen>> | null = null
  try {
    fh = await fsOpen(filePath, 'r')
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return bytesRead === 4 && buf.equals(GGUF_MAGIC)
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

export async function isModelDownloaded(modelId: string): Promise<boolean> {
  const entry = REGISTRY[modelId]
  if (!entry) return false
  try {
    const p = getModelPath(modelId)
    if (!existsSync(p)) return false
    const { size } = await stat(p)
    if (size < entry.sizeBytes * COMPLETE_THRESHOLD) return false
    return hasGgufMagic(p)
  } catch {
    return false
  }
}

export async function downloadModel(
  modelId: string,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  const entry = REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model ID: ${modelId}`)

  ensureModelsDir()
  const destPath = getModelPath(modelId)

  // Range-resume: see how much is already on disk
  let startByte = 0
  try {
    const { size } = await stat(destPath)
    // If the existing fragment is suspiciously small (e.g. a saved HTML error page), discard it
    if (size > 0 && size < 1024 * 1024) {
      await unlink(destPath)
    } else {
      startByte = size
      if (startByte >= entry.sizeBytes) return // already complete
    }
  } catch {
    // file doesn't exist — start from 0
  }

  await new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`

    const request = net.request({ url: entry.url, headers })

    request.on('response', (response) => {
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        reject(new Error(`HTTP ${response.statusCode} downloading model`))
        return
      }

      // Prefer Content-Range total over our hardcoded estimate
      let totalBytes = entry.sizeBytes
      const contentRange = response.headers['content-range'] as string | undefined
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) totalBytes = parseInt(match[1], 10)
      } else if (response.statusCode === 200) {
        const cl = response.headers['content-length'] as string | undefined
        if (cl) totalBytes = parseInt(cl, 10)
      }

      const writeStream = createWriteStream(destPath, {
        flags: startByte > 0 ? 'a' : 'w',
      })
      let downloaded = startByte

      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        writeStream.write(chunk)
        onProgress(downloaded, totalBytes)
      })

      response.on('end', () => {
        writeStream.end()
        writeStream.once('finish', resolve)
        writeStream.once('error', reject)
      })

      response.on('error', (err: Error) => {
        writeStream.destroy()
        reject(err)
      })
    })

    request.on('error', async (err: Error) => {
      try {
        const { size } = await stat(destPath)
        if (size === 0) await unlink(destPath)
      } catch { /* ignore */ }
      reject(err)
    })

    request.end()
  })

  // Validate the completed file starts with GGUF magic bytes.
  // A failed HuggingFace auth returns HTTP 200 with an HTML login page — catch that here.
  if (!(await hasGgufMagic(destPath))) {
    await unlink(destPath).catch(() => {})
    throw new Error(
      'Downloaded file is not a valid model. ' +
      'If the model requires a HuggingFace account, download it manually and place it in the models folder.'
    )
  }
}
