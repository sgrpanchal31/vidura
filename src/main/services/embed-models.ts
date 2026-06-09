import { join } from 'path'
import { existsSync, rmSync, readdirSync } from 'fs'

export type EmbedModelEntry = {
  hfId: string
  name: string
  desc: string
  sizeLabel: string
  dim: number
  recommended: boolean
  dtype?: string
  pooling?: 'mean' | 'last_token'
  tags: string[]
}

export const DEFAULT_EMBED = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'

export const EMBED_REGISTRY: Record<string, EmbedModelEntry> = {
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    hfId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    name: 'Qwen3 Embedding 0.6B',
    desc: 'Best retrieval quality. Multilingual, 1024-dim. Downloads and runs entirely on your Mac — no external software required.',
    sizeLabel: '~600 MB',
    dim: 1024,
    recommended: true,
    dtype: 'q8',
    pooling: 'last_token',
    tags: ['Recommended', 'Multilingual'],
  },
}

export function embedDim(hfId: string): number {
  return EMBED_REGISTRY[hfId]?.dim ?? 1024
}

function getModelsDir(): string {
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return join(require('electron').app.getPath('userData'), 'models')
  }
  return join(process.env.OPENBOOK_MODELS_DIR ?? '', 'models')
}

export async function isEmbedDownloaded(hfId: string): Promise<boolean> {
  try {
    // Transformers.js stores models as <cache_dir>/<org>/<repo>/onnx/model*.onnx
    const dir = join(getModelsDir(), ...hfId.split('/'))
    if (!existsSync(dir)) return false
    const onnxDir = join(dir, 'onnx')
    if (!existsSync(onnxDir)) return false
    return readdirSync(onnxDir).some((f) => f.endsWith('.onnx'))
  } catch {
    return false
  }
}

export type EmbedModelInfo = EmbedModelEntry & { downloaded: boolean }

export async function listEmbedModels(): Promise<EmbedModelInfo[]> {
  return Promise.all(
    Object.values(EMBED_REGISTRY).map(async (entry) => ({
      ...entry,
      downloaded: await isEmbedDownloaded(entry.hfId),
    }))
  )
}

export async function deleteEmbed(hfId: string): Promise<void> {
  const dir = join(getModelsDir(), ...hfId.split('/'))
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
