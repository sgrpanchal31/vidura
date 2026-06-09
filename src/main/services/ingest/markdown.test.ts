import { describe, it, expect } from 'vitest'
import { parseMarkdown } from './markdown'

// parseMarkdown splits a markdown string into sections at each heading.
// Each section carries the heading line, a breadcrumb path, and the body text
// (with the heading prepended so it's present in the embedded chunk).

describe('parseMarkdown', () => {
  it('returns the full content as one section when there are no headings', () => {
    const sections = parseMarkdown('Just some plain text.\nNo headings here.')
    expect(sections).toHaveLength(1)
    expect(sections[0].headingAnchor).toBe('')
    expect(sections[0].text).toContain('Just some plain text')
  })

  it('splits on a top-level heading and prepends it to the body', () => {
    const md = '# Intro\n\nHello world.\n\n## Details\n\nMore info here.'
    const sections = parseMarkdown(md)
    expect(sections).toHaveLength(2)
    // The heading line should be the first thing in the text of each section
    expect(sections[0].text).toMatch(/^# Intro/)
    expect(sections[1].text).toMatch(/^## Details/)
  })

  it('sets headingAnchor to the raw heading line', () => {
    const md = '# Guide\n\nIntro text.\n\n## Setup\n\nInstall it.'
    const sections = parseMarkdown(md)
    expect(sections[0].headingAnchor).toBe('# Guide')
    expect(sections[1].headingAnchor).toBe('## Setup')
  })

  it('builds a breadcrumb headingPath for nested headings', () => {
    const md = '# Guide\n\nIntro.\n\n## Setup\n\nInstall.\n\n### Config\n\nConfigure it.'
    const sections = parseMarkdown(md)
    const setupSection = sections.find((s) => s.headingAnchor === '## Setup')
    const configSection = sections.find((s) => s.headingAnchor === '### Config')
    expect(setupSection?.headingPath).toBe('Guide > Setup')
    expect(configSection?.headingPath).toBe('Guide > Setup > Config')
  })

  it('resets deeper levels when a higher-level heading appears', () => {
    // After # C appears, the ## B level should be cleared,
    // so # C's path is just "C" (not "A > B > C" or similar).
    const md = '# A\n\n## B\n\nText.\n\n# C\n\nNew top-level.'
    const sections = parseMarkdown(md)
    const cSection = sections.find((s) => s.headingAnchor === '# C')
    expect(cSection?.headingPath).toBe('C')
  })

  it('returns a single section with empty text for empty input', () => {
    const sections = parseMarkdown('')
    expect(sections).toHaveLength(1)
    expect(sections[0].text).toBe('')
  })
})
