import { join } from 'path'
import { app, net } from 'electron'
import { existsSync, createWriteStream, mkdirSync } from 'fs'
import { stat, unlink, open as fsOpen } from 'fs/promises'
import os from 'os'

// Resolved lazily so this module also loads outside Electron (the eval
// harness runs services under tsx, where `app` doesn't exist) — same
// cacheDir pattern as embed.ts.
function modelsDir(): string {
  if (process.versions.electron) return join(app.getPath('userData'), 'models')
  return process.env.OPENBOOK_MODELS_DIR ?? join(os.homedir(), '.openbook', 'models')
}

// A file is only "downloaded" if it's at least this fraction of the expected size.
// Catches partial downloads that were interrupted mid-stream.
const COMPLETE_THRESHOLD = 0.95

// GGUF magic bytes: ASCII "GGUF" at offset 0
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii')

type ModelEntry = {
  filename: string
  // HuggingFace /resolve/main/ URLs — Electron net follows CDN redirects automatically.
  url: string
  sizeBytes: number
}

// Sizes are approximate bytes used for progress %. Server Content-Range overrides.
const REGISTRY: Record<string, ModelEntry> = {
  'gemma4-e2b': {
    filename: 'gemma4-e2b.gguf',
    url: 'https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf',
    sizeBytes: 3_350_000_000,
  },
  'llama3.2-3b': {
    filename: 'llama3.2-3b.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_019_377_152,
  },
  'gemma4-e4b': {
    filename: 'gemma4-e4b.gguf',
    url: 'https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B_q4_0-it.gguf',
    sizeBytes: 5_150_000_000,
  },
  'gemma4-12b': {
    filename: 'gemma4-12b.gguf',
    url: 'https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/main/gemma-4-12b-it-qat-q4_0.gguf',
    sizeBytes: 6_980_000_000,
  },
  'gpt-oss-20b': {
    filename: 'gpt-oss-20b.gguf',
    url: 'https://huggingface.co/unsloth/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-Q4_K_M.gguf',
    sizeBytes: 11_600_000_000,
  },
  // Cross-encoder reranker — Q8_0 for quality (small rerankers are sensitive to quantization noise)
  'bge-reranker-v2-m3': {
    filename: 'bge-reranker-v2-m3.gguf',
    url: 'https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf',
    sizeBytes: 635_676_416,
  },
}

const LLM_IDS = ['gemma4-e2b', 'llama3.2-3b', 'gemma4-e4b', 'gemma4-12b', 'gpt-oss-20b'] as const

function ensureModelsDir(): void {
  mkdirSync(modelsDir(), { recursive: true })
}

export function getModelPath(modelId: string): string {
  ensureModelsDir()
  const entry = REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model ID: ${modelId}`)
  return join(modelsDir(), entry.filename)
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

// Two-pronged cancel:
//  1. cancelRequested flag — checked in data handler to stop progress events immediately
//  2. activeDownloadReject — called directly to settle the promise without waiting for a net event
// abort() alone is unreliable once Electron's net response stream is active.
let cancelRequested = false
let activeDownloadRequest: ReturnType<typeof net.request> | null = null
let activeDownloadReject: ((e: Error) => void) | null = null
let activeWriteStream: ReturnType<typeof createWriteStream> | null = null

export function cancelDownload(): void {
  cancelRequested = true
  activeDownloadRequest?.abort()
  activeDownloadRequest = null
  activeWriteStream?.destroy()
  activeWriteStream = null
  activeDownloadReject?.(new Error('DOWNLOAD_CANCELLED'))
  activeDownloadReject = null
}

export async function downloadModel(
  modelId: string,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  const entry = REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model ID: ${modelId}`)

  cancelRequested = false
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

  try {
    await new Promise<void>((resolve, reject) => {
      activeDownloadReject = reject

      const headers: Record<string, string> = {}
      if (startByte > 0) headers['Range'] = `bytes=${startByte}-`

      const request = net.request({ url: entry.url, headers })
      activeDownloadRequest = request

      request.on('response', (response) => {
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          activeDownloadRequest = null
          activeDownloadReject = null
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
        activeWriteStream = writeStream
        let downloaded = startByte

        response.on('data', (chunk: Buffer) => {
          // Flag checked first — stops progress events from firing after cancel
          if (cancelRequested) return
          downloaded += chunk.length
          writeStream.write(chunk)
          onProgress(downloaded, totalBytes)
        })

        response.on('end', () => {
          activeDownloadRequest = null
          activeDownloadReject = null
          activeWriteStream = null
          writeStream.end()
          writeStream.once('finish', resolve)
          writeStream.once('error', reject)
        })

        response.on('error', (err: Error) => {
          activeDownloadRequest = null
          activeDownloadReject = null
          activeWriteStream = null
          writeStream.destroy()
          reject(err)
        })
      })

      request.on('error', (err: Error) => {
        activeDownloadRequest = null
        activeDownloadReject = null
        reject(err)
      })

      request.end()
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'DOWNLOAD_CANCELLED') {
      // Delete the partial file — user chose to cancel, not resume
      await unlink(destPath).catch(() => {})
      throw err
    }
    // For network errors: clean up zero-byte files only
    try {
      const { size } = await stat(destPath)
      if (size === 0) await unlink(destPath)
    } catch {
      /* ignore */
    }
    throw err
  }

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

export type LlmModelInfo = {
  id: string
  filename: string
  sizeBytes: number
  downloaded: boolean
}

export async function listModels(): Promise<LlmModelInfo[]> {
  return Promise.all(
    LLM_IDS.map(async (id) => ({
      id,
      filename: REGISTRY[id].filename,
      sizeBytes: REGISTRY[id].sizeBytes,
      downloaded: await isModelDownloaded(id),
    }))
  )
}

export async function deleteModel(modelId: string): Promise<void> {
  const entry = REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model ID: ${modelId}`)
  const p = getModelPath(modelId)
  if (existsSync(p)) {
    await unlink(p)
  }
}
