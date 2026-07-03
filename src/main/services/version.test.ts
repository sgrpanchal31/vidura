import { describe, it, expect } from 'vitest'
import { isNewerVersion } from './version'

describe('isNewerVersion', () => {
  it('detects newer patch, minor, and major versions', () => {
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.3.0', '0.2.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
  })

  it('returns false for equal or older versions', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.2.0', '1.0.0')).toBe(false)
  })

  it('tolerates malformed input by treating missing parts as zero', () => {
    expect(isNewerVersion('0.2', '0.1.9')).toBe(true)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('abc', '0.0.1')).toBe(false)
  })
})
