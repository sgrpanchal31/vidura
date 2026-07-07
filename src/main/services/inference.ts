// node-llama-cpp is ESM-only. Loaded via dynamic import() to satisfy the CJS main bundle.
import type { Llama, LlamaModel, GbnfJsonSchema, LlamaGrammar } from 'node-llama-cpp'
import { getModelPath } from './models'

const MODEL_LOAD_TIMEOUT_MS = 30_000 // watchdog for OOM (TODOS TODO-2)
const CONTEXT_SIZE = 8192

type NodeLlamaCppModule = typeof import('node-llama-cpp')

let _mod: NodeLlamaCppModule | null = null

async function mod(): Promise<NodeLlamaCppModule> {
  if (!_mod) _mod = (await import('node-llama-cpp')) as NodeLlamaCppModule
  return _mod
}

// Handle for one agent run: JSON-constrained decision turns and free-text
// answer turns share one chat session (and its KV cache). Always dispose() —
// it frees the context and releases the generating mutex.
export type AgentSession = {
  signal: AbortSignal
  promptJson(text: string, grammar: LlamaGrammar, opts: { maxTokens: number }): Promise<string>
  promptText(text: string, opts: { onToken: (token: string) => void }): Promise<string>
  dispose(): Promise<void>
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
      // swaFullCache=true: Gemma 4 uses SWA (sliding window attention); without this
      // flag node-llama-cpp checkpoints the KV cache after every token, and the
      // checkpoint writer crashes on Gemma 4 E4B's shared-KV layer structure.
      context = await this.model.createContext({ contextSize: CONTEXT_SIZE, swaFullCache: true })
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

  // Compiles a JSON-Schema into a sampling grammar. Generation under a grammar
  // is constrained token-by-token: the model physically cannot emit JSON that
  // violates the schema. This is what makes small local models reliable tool
  // callers — the agent loop's decisions are sampled this way.
  async createJsonGrammar(schema: GbnfJsonSchema): Promise<LlamaGrammar> {
    const llama = await this.ensureLlama()
    // Cast: createGrammarForJsonSchema's generic wants a literal schema type;
    // ours is built dynamically from the tool registry.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return llama.createGrammarForJsonSchema(schema as any)
  }

  // A multi-turn session for one agent run. Unlike generateStream (fresh
  // context per call), the context lives across turns so the KV cache is
  // reused — each step only pays for the new text, not the whole transcript.
  // Holds the same generating mutex as generateStream, so cancel() aborts
  // agent runs exactly like it aborts old-pipeline generations.
  async createAgentSession(systemPrompt: string): Promise<AgentSession> {
    if (!this.model) throw new Error('No model loaded — call loadModel() first')
    if (this.generating) throw new Error('Already generating — call cancel() first')

    const { LlamaChatSession } = await mod()

    this.generating = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    // Same context flags as generateStream (see comment there re: swaFullCache)
    let context: Awaited<ReturnType<LlamaModel['createContext']>>
    try {
      context = await this.model.createContext({ contextSize: CONTEXT_SIZE, swaFullCache: true })
    } catch (err) {
      // Release the mutex if the context never came up, or generation locks forever
      this.generating = false
      this.abortController = null
      throw err
    }
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    })

    const release = async (): Promise<void> => {
      try {
        // Cast: dispose() is missing from the published context type
        await (context as any)?.dispose?.()
      } catch {
        /* ignore */
      }
      this.generating = false
      this.abortController = null
    }

    return {
      signal,
      promptJson: async (text, grammar, opts) => {
        // Cast: prompt()'s grammar generic wants a literal schema type; ours is dynamic
        return session.prompt(text, { signal, grammar: grammar as any, maxTokens: opts.maxTokens })
      },
      promptText: async (text, opts) => {
        let fullText = ''
        await session.prompt(text, {
          signal,
          onTextChunk(t: string) {
            fullText += t
            opts.onToken(t)
          },
        })
        return fullText
      },
      dispose: release,
    }
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
