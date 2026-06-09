import { describe, it, expect } from 'vitest'
import { parseText } from './text'

// parseText is intentionally trivial: it trims the input and wraps it in the
// ParsedText shape. Tests here mainly serve as a contract — if anyone changes
// parseText in a way that breaks the expected shape, the suite catches it.

describe('parseText', () => {
  it('returns the content with lineNumber always equal to 1', () => {
    const result = parseText('Hello world')
    expect(result.text).toBe('Hello world')
    expect(result.lineNumber).toBe(1)
  })

  it('trims leading and trailing whitespace', () => {
    const result = parseText('  hello  \n')
    expect(result.text).toBe('hello')
  })

  it('handles empty string without throwing', () => {
    const result = parseText('')
    expect(result.text).toBe('')
    expect(result.lineNumber).toBe(1)
  })
})
