// Minimal WAV (RIFF) encoder for TTS output. PCM 16-bit mono only — that is
// the one format the podcast pipeline produces, so nothing else is supported.

// Join synthesized segments into one continuous sample buffer
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// Encode float samples ([-1, 1], clamped) as a 16-bit PCM mono WAV file
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4) // RIFF chunk size
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // audio format: PCM
  buf.writeUInt16LE(1, 22) // channels: mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate = sampleRate * blockAlign
  buf.writeUInt16LE(2, 32) // block align = channels * bytesPerSample
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    // 0x7fff for positive, 0x8000 for negative — standard float-to-int16 scaling
    buf.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), 44 + i * 2)
  }
  return buf
}
