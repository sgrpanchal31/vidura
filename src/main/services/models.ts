import { join } from 'path'
import { app, net } from 'electron'
import { existsSync, createWriteStream, mkdirSync } from 'fs'
import { stat, unlink } from 'fs/promises'

const MODELS_DIR = join(app.getPath('userData'), 'models')

type ModelEntry = {
  filename: string
  // HuggingFace /resolve/main/ URLs — redirected by Electron net to CDN automatically
  url: string
  sizeBytes: number
}

// Sizes are approximate Q4_K_M GGUF sizes used for progress %. Server Content-Range overrides.
const REGISTRY: Record<string, ModelEntry> = {
  'gemma2-2b': {
    filename: 'gemma2-2b.gguf',
    url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
    sizeBytes: 1_619_058_688,
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

export function isModelDownloaded(modelId: string): boolean {
  try {
    return existsSync(getModelPath(modelId))
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

  // Range-resume: how much have we already downloaded?
  let startByte = 0
  try {
    const st = await stat(destPath)
    startByte = st.size
    if (startByte >= entry.sizeBytes) return // already complete
  } catch {
    // file doesn't exist — start from 0
  }

  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`

    // Electron net handles HuggingFace → CDN redirects automatically
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

      response.on('error', async (err: Error) => {
        writeStream.destroy()
        // Partial file remains for range-resume on next attempt — don't delete
        reject(err)
      })
    })

    request.on('error', async (err: Error) => {
      // If the file is completely absent still, clean up zero-byte artifacts
      try {
        const st = await stat(destPath)
        if (st.size === 0) await unlink(destPath)
      } catch {
        // ignore
      }
      reject(err)
    })

    request.end()
  })
}
