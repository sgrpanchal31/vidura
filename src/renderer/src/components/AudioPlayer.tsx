import { useState, useEffect, useRef } from 'react'
import type { MessageAudio } from '../../../preload'
import './AudioPlayer.css'

const SPEEDS = [1, 1.25, 1.5, 2]

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function IconPlay({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" stroke="none">
      <path d="M3.5 2.2v9.6L11.5 7z" />
    </svg>
  )
}

function IconPause({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" stroke="none">
      <rect x="3" y="2.2" width="2.6" height="9.6" rx="0.8" />
      <rect x="8.4" y="2.2" width="2.6" height="9.6" rx="0.8" />
    </svg>
  )
}

type AudioPlayerProps = {
  folder: string
  audio: MessageAudio
}

export default function AudioPlayer({ folder, audio }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [srcUrl, setSrcUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(audio.durationSec)
  const [speedIdx, setSpeedIdx] = useState(0)

  // Load the WAV bytes over IPC into a blob URL (the renderer cannot read notebook files directly)
  useEffect(() => {
    let revoked: string | null = null
    let stale = false
    window.api
      .audioRead(folder, audio.file)
      .then((bytes) => {
        if (stale) return
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }))
        revoked = url
        setSrcUrl(url)
      })
      .catch(() => {
        if (!stale) setLoadError(true)
      })
    return () => {
      stale = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [folder, audio.file])

  if (loadError) {
    return <div className="audio-player audio-player--error">Audio file not found.</div>
  }

  function togglePlay() {
    const el = audioRef.current
    if (!el) return
    if (el.paused) el.play()
    else el.pause()
  }

  function cycleSpeed() {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]
  }

  function seek(sec: number) {
    const el = audioRef.current
    if (!el) return
    el.currentTime = sec
    setCurrentTime(sec)
  }

  // Current chapter = last chapter whose start time has passed
  const activeChapter = audio.chapters.reduce((acc, ch, i) => (currentTime >= ch.startSec - 0.25 ? i : acc), -1)

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={srcUrl ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration)
        }}
      />
      <div className="audio-controls">
        <button className="audio-play-btn" onClick={togglePlay} disabled={!srcUrl} title={playing ? 'Pause' : 'Play'}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="audio-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <input
          className="audio-scrubber"
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(currentTime, duration)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <button className="audio-speed-btn" onClick={cycleSpeed} title="Playback speed">
          {SPEEDS[speedIdx]}x
        </button>
      </div>
      {audio.chapters.length > 0 && (
        <div className="audio-chapters">
          {audio.chapters.map((ch, i) => (
            <button
              key={i}
              className={`audio-chapter${i === activeChapter ? ' audio-chapter--active' : ''}`}
              onClick={() => seek(ch.startSec)}
              title={`Jump to ${formatTime(ch.startSec)}`}
            >
              {ch.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
