import { useState, useEffect } from 'react'
import './Onboarding.css'
import logoUrl from '../assets/logo.svg'

type Model = {
  id: string
  name: string
  desc: string
  size: string
  minRamGB: number
}

const MODELS: Model[] = [
  {
    id: 'gemma4-e2b',
    name: 'Gemma 4 E2B',
    desc: "Google's smallest Gemma 4 model. Fast and works on any Mac, including 8 GB models.",
    size: '3.4 GB',
    minRamGB: 0,
  },
  {
    id: 'llama3.2-3b',
    name: 'Llama 3.2 3B',
    desc: 'Slightly larger. Better on dense academic text and long-form sources.',
    size: '2.0 GB',
    minRamGB: 8,
  },
  {
    id: 'gemma4-e4b',
    name: 'Gemma 4 E4B',
    desc: "Google's efficient edge model. Better quality than E2B, works on 8 GB and 16 GB Macs.",
    size: '5.2 GB',
    minRamGB: 8,
  },
  {
    id: 'gemma4-12b',
    name: 'Gemma 4 12B',
    desc: 'High quality. Requires 24 GB RAM or more.',
    size: '7.0 GB',
    minRamGB: 24,
  },
  {
    id: 'gpt-oss-20b',
    name: 'GPT-OSS 20B',
    desc: "OpenAI's open-weight model. Best reasoning quality. Needs 32 GB RAM.",
    size: '11.6 GB',
    minRamGB: 32,
  },
]

function recommendedModelId(ramGB: number): string {
  if (ramGB >= 32) return 'gpt-oss-20b'
  if (ramGB >= 24) return 'gemma4-12b'
  return 'gemma4-e4b'
}

type Props = {
  onComplete: (folder: string, modelId: string) => void
}

export default function Onboarding({ onComplete }: Props) {
  const [folder, setFolder] = useState<string | null>(null)
  const [modelId, setModelId] = useState('gemma4-e4b')
  const [ramGB, setRamGB] = useState<number | null>(null)
  const [recommendedId, setRecommendedId] = useState('gemma4-e4b')
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
          <span className="win-title">Vidura</span>
        </div>
      )}

      <div className="logo-hero">
        <img src={logoUrl} alt="" className="logo-mark" />
      </div>

      <div className="zone">
        <div className="eyebrow">Notebook Folder</div>
        <div className="path-row">
          <div className={`path-field${folder ? '' : ' empty'}`}>{folder ?? 'No folder selected yet'}</div>
          <button className="btn-primary" onClick={handlePickFolder}>
            Choose folder
          </button>
        </div>
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
          {MODELS.map((model) => {
            // Selecting a model bigger than the machine's RAM would hang or crash
            // on first load, so out-of-reach models are visible but not selectable
            const tooBig = ramGB !== null && model.minRamGB > ramGB
            return (
              <div
                key={model.id}
                className={`model-row${modelId === model.id ? ' sel' : ''}${tooBig ? ' unavailable' : ''}`}
                onClick={tooBig ? undefined : () => setModelId(model.id)}
              >
                <div className="radio" />
                <div className="model-info">
                  <div className="model-name">
                    {model.name}
                    {model.id === recommendedId && <span className="tag-rec">Recommended</span>}
                    {tooBig && <span className="tag-ram">Needs {model.minRamGB} GB RAM</span>}
                  </div>
                  <div className="model-desc">{model.desc}</div>
                </div>
                <div className="model-size">{model.size}</div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="win-footer">All data stays on this machine · no account required</div>

      {folder && (
        <div className="cta-row">
          <button className="btn-primary" onClick={() => onComplete(folder, modelId)}>
            Open notebook →
          </button>
        </div>
      )}
    </>
  )
}
