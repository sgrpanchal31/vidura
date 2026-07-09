import type { LlamaModel, LlamaRankingContext } from 'node-llama-cpp'
import { getModelPath } from './models'

type NodeLlamaCppModule = typeof import('node-llama-cpp')

let _mod: NodeLlamaCppModule | null = null
async function mod(): Promise<NodeLlamaCppModule> {
  if (!_mod) _mod = (await import('node-llama-cpp')) as NodeLlamaCppModule
  return _mod
}

export type RerankerStatus = 'idle' | 'starting' | 'ready' | 'error'

const RERANKER_MODEL_ID = 'bge-reranker-v2-m3'

class RerankerGgufService {
  private model: LlamaModel | null = null
  private context: LlamaRankingContext | null = null
  private _status: RerankerStatus = 'idle'

  async start(): Promise<void> {
    if (this._status === 'ready' || this._status === 'starting') return
    this._status = 'starting'
    try {
      const { getLlama } = await mod()
      const llama = await getLlama()
      const modelPath = getModelPath(RERANKER_MODEL_ID)
      this.model = await llama.loadModel({ modelPath })
      this.context = await this.model.createRankingContext()
      this._status = 'ready'
    } catch (err) {
      this._status = 'error'
      this.model = null
      this.context = null
      throw err
    }
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (!this.context) throw new Error('Reranker not ready')
    return this.context.rankAll(query, documents)
  }

  isReady(): boolean {
    return this._status === 'ready'
  }

  getStatus(): RerankerStatus {
    return this._status
  }

  async stop(): Promise<void> {
    const ctx = this.context
    const model = this.model
    this.context = null
    this.model = null
    this._status = 'idle'
    await Promise.all([ctx?.dispose().catch(() => {}), (model as any)?.dispose?.().catch(() => {})])
  }
}

export const rerankerGgufService = new RerankerGgufService()
