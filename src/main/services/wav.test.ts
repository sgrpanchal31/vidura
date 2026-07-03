import { describe, it, expect } from 'vitest'
import { encodeWavPcm16, concatFloat32 } from './wav'

describe('encodeWavPcm16', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const buf = encodeWavPcm16(new Float32Array([0, 0.5]), 24000)
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ')
    expect(buf.toString('ascii', 36, 40)).toBe('data')
  })

  it('total length is 44 header bytes plus 2 bytes per sample', () => {
    const buf = encodeWavPcm16(new Float32Array(100), 24000)
    expect(buf.length).toBe(44 + 200)
    expect(buf.readUInt32LE(4)).toBe(36 + 200) // RIFF chunk size
    expect(buf.readUInt32LE(40)).toBe(200) // data chunk size
  })

  it('encodes format fields for 16-bit mono PCM', () => {
    const buf = encodeWavPcm16(new Float32Array(10), 24000)
    expect(buf.readUInt16LE(20)).toBe(1) // PCM
    expect(buf.readUInt16LE(22)).toBe(1) // mono
    expect(buf.readUInt32LE(24)).toBe(24000) // sample rate
    expect(buf.readUInt32LE(28)).toBe(48000) // byte rate
    expect(buf.readUInt16LE(32)).toBe(2) // block align
    expect(buf.readUInt16LE(34)).toBe(16) // bits per sample
  })

  it('scales known sample values to int16', () => {
    const buf = encodeWavPcm16(new Float32Array([0, 1, -1, 0.5]), 24000)
    expect(buf.readInt16LE(44)).toBe(0)
    expect(buf.readInt16LE(46)).toBe(32767)
    expect(buf.readInt16LE(48)).toBe(-32768)
    expect(buf.readInt16LE(50)).toBe(Math.round(0.5 * 32767))
  })

  it('clamps out-of-range samples', () => {
    const buf = encodeWavPcm16(new Float32Array([2.5, -3.7]), 24000)
    expect(buf.readInt16LE(44)).toBe(32767)
    expect(buf.readInt16LE(46)).toBe(-32768)
  })

  it('empty input produces a valid 44-byte file', () => {
    const buf = encodeWavPcm16(new Float32Array(0), 24000)
    expect(buf.length).toBe(44)
    expect(buf.readUInt32LE(40)).toBe(0)
  })
})

describe('concatFloat32', () => {
  it('joins chunks in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('handles empty input', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})
