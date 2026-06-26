// node-llama-cpp is ESM-only. Loaded via dynamic import() to satisfy the CJS main bundle.
import type { Llama, LlamaModel } from 'node-llama-cpp'
import { getModelPath } from './models'

const MODEL_LOAD_TIMEOUT_MS = 30_000 // watchdog for OOM (TODOS TODO-2)
const CONTEXT_SIZE = 4096

type NodeLlamaCppModule = typeof import('node-llama-cpp')

let _mod: NodeLlamaCppModule | null = null

async function mod(): Promise<NodeLlamaCppModule> {
  if (!_mod) _mod = (await import('node-llama-cpp')) as NodeLlamaCppModule
  return _mod
}

class LlamaService {
  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private loadedModelId: string | null = null
  private abortController: AbortController | null = null
  private generating = false

  private async ensureLlama(): Promise<Llama> {
    if (!this.llama) {
      const { getLlama } = await mod()
      this.llama = await getLlama()
    }
    return this.llama
  }

  async loadModel(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId && this.model) return

    await this.unloadModel()

    const llama = await this.ensureLlama()
    const modelPath = getModelPath(modelId)

    // Watchdog: native llama.cpp allocations can hang on OOM rather than throwing
    let timeoutHandle!: ReturnType<typeof setTimeout>
    const loadWithWatchdog = new Promise<LlamaModel>((resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('Not enough memory to run this model.')), MODEL_LOAD_TIMEOUT_MS)
      llama
        .loadModel({ modelPath })
        .then((m) => {
          clearTimeout(timeoutHandle)
          resolve(m)
        })
        .catch((err) => {
          clearTimeout(timeoutHandle)
          reject(err)
        })
    })

    this.model = await loadWithWatchdog
    this.loadedModelId = modelId
  }

  async unloadModel(): Promise<void> {
    this.abortController?.abort()
    this.abortController = null
    this.generating = false

    if (this.model) {
      try {
        await (this.model as any).dispose?.()
      } catch {
        /* ignore */
      }
      this.model = null
      this.loadedModelId = null
    }
  }

  isLoaded(modelId?: string): boolean {
    if (modelId !== undefined) return this.loadedModelId === modelId
    return this.model !== null
  }

  getLoadedModelId(): string | null {
    return this.loadedModelId
  }

  async generateStream(
    systemPrompt: string,
    userPrompt: string,
    onToken: (token: string) => void,
    opts?: { maxTokens?: number }
  ): Promise<string> {
    if (!this.model) throw new Error('No model loaded — call loadModel() first')
    if (this.generating) throw new Error('Already generating — call cancel() first')

    const { LlamaChatSession } = await mod()

    this.generating = true
    this.abortController = new AbortController()
    let context: Awaited<ReturnType<typeof this.model.createContext>> | null = null

    try {
      // Fresh context per query — no history leakage between RAG calls
      context = await this.model.createContext({
        contextSize: CONTEXT_SIZE,
        flashAttention: true,
        experimentalKvCacheKeyType: 'Q8_0',
        experimentalKvCacheValueType: 'Q8_0',
      })
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt,
      })

      let fullText = ''
      await session.prompt(userPrompt, {
        signal: this.abortController.signal,
        ...(opts?.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        onTextChunk(text: string) {
          fullText += text
          onToken(text)
        },
      })
      return fullText
    } finally {
      try {
        await (context as any)?.dispose?.()
      } catch {
        /* ignore */
      }
      this.generating = false
      this.abortController = null
    }
  }

  cancel(): void {
    this.abortController?.abort()
    this.generating = false
  }

  async dispose(): Promise<void> {
    await this.unloadModel()
    if (this.llama) {
      try {
        await (this.llama as any).dispose?.()
      } catch {
        /* ignore */
      }
      this.llama = null
    }
  }
}

export const llamaService = new LlamaService()
