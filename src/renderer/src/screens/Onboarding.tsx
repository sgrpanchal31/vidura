import { useState, useEffect } from 'react'
import './Onboarding.css'

type Model = {
  id: string
  name: string
  desc: string
  size: string
  minRamGB: number
}

const MODELS: Model[] = [
  {
    id: 'gemma2-2b',
    name: 'Qwen 2.5 1.5B',
    desc: 'Fast, accurate, optimised for Apple Silicon. Best starting point for most notebooks.',
    size: '1.0 GB',
    minRamGB: 0
  },
  {
    id: 'llama3.2-3b',
    name: 'Llama 3.2 3B',
    desc: 'Slightly larger. Better on dense academic text and long-form sources.',
    size: '2.0 GB',
    minRamGB: 8
  },
  {
    id: 'qwen2.5-7b',
    name: 'Qwen 2.5 7B',
    desc: 'Highest quality. Requires 32 GB RAM or more.',
    size: '4.4 GB',
    minRamGB: 32
  },
  {
    id: 'phi3-mini',
    name: 'Phi-3 Mini',
    desc: "Microsoft's compact model. Good on structured notes and lists.",
    size: '2.3 GB',
    minRamGB: 0
  }
]

function recommendedModelId(ramGB: number): string {
  if (ramGB >= 32) return 'qwen2.5-7b'
  if (ramGB >= 16) return 'llama3.2-3b'
  return 'gemma2-2b'
}

type Props = {
  onComplete: (folder: string, modelId: string) => void
}

export default function Onboarding({ onComplete }: Props) {
  const [folder, setFolder] = useState<string | null>(null)
  const [modelId, setModelId] = useState('gemma2-2b')
  const [ramGB, setRamGB] = useState<number | null>(null)
  const [recommendedId, setRecommendedId] = useState('gemma2-2b')
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    window.api.getSystemInfo().then(({ totalRamGB, platform }) => {
      setRamGB(totalRamGB)
      setIsMac(platform === 'darwin')
      const rec = recommendedModelId(totalRamGB)
      setRecommendedId(rec)
      setModelId(rec)
    })
  }, [])

  async function handlePickFolder() {
    const picked = await window.api.pickFolder()
    if (picked) setFolder(picked)
  }

  const recommendedModel = MODELS.find((m) => m.id === recommendedId)

  return (
    <>
      {isMac && (
        <div className="titlebar">
          <span className="win-title">openbook-lm</span>
        </div>
      )}

      <div className="zone">
        <div className="eyebrow">Notebook Folder</div>
        <div className="path-row">
          <div className={`path-field${folder ? '' : ' empty'}`}>
            {folder ?? 'No folder selected yet'}
          </div>
          <button className="btn-primary" onClick={handlePickFolder}>
            Choose folder
          </button>
        </div>
        <a className="link-secondary" onClick={(e) => e.preventDefault()}>
          Try with demo folder →
        </a>
      </div>

      <div className="divider" />

      <div className="model-zone">
        <div className="model-heading">Choose a language model</div>
        {ramGB !== null && (
          <div className="hw-line">
            {ramGB} GB RAM detected — {recommendedModel?.name} recommended
          </div>
        )}
        <div className="model-list">
          {MODELS.map((model) => (
            <div
              key={model.id}
              className={`model-row${modelId === model.id ? ' sel' : ''}`}
              onClick={() => setModelId(model.id)}
            >
              <div className="radio" />
              <div className="model-info">
                <div className="model-name">
                  {model.name}
                  {model.id === recommendedId && (
                    <span className="tag-rec">Recommended</span>
                  )}
                </div>
                <div className="model-desc">{model.desc}</div>
              </div>
              <div className="model-size">{model.size}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="win-footer">
        All data stays on this machine · no account required
      </div>

      {folder && (
        <div className="cta-row">
          <button
            className="btn-primary"
            onClick={() => onComplete(folder, modelId)}
          >
            Open notebook →
          </button>
        </div>
      )}
    </>
  )
}
