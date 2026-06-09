export type MarkdownSection = {
  headingAnchor: string // raw heading line, e.g. "## Setup"
  headingPath: string // breadcrumb, e.g. "Guide > Setup"
  text: string // heading + body (heading prepended for embedding context)
  lineNumber: number
}

export function parseMarkdown(content: string): MarkdownSection[] {
  const lines = content.split('\n')
  const sections: MarkdownSection[] = []
  let currentHeading = ''
  let currentHeadingPath = ''
  let currentBody: string[] = []
  let headingLine = 1

  // Maps heading level (1–6) to the current heading text at that level.
  // When a new heading is encountered, all deeper levels are cleared.
  const headingsByLevel = new Map<number, string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const levelMatch = line.match(/^(#{1,6})\s/)
    if (levelMatch) {
      if (currentBody.join('').trim()) {
        sections.push({
          headingAnchor: currentHeading,
          headingPath: currentHeadingPath,
          text: (currentHeading ? currentHeading + '\n\n' : '') + currentBody.join('\n').trim(),
          lineNumber: headingLine,
        })
      }
      const level = levelMatch[1].length
      const headingText = line.replace(/^#{1,6}\s+/, '').trim()
      // Clear this level and all deeper levels (they're no longer in scope)
      for (const k of headingsByLevel.keys()) {
        if (k >= level) headingsByLevel.delete(k)
      }
      headingsByLevel.set(level, headingText)
      // Build breadcrumb from levels 1..level in order, skipping gaps
      const parts: string[] = []
      for (let l = 1; l <= level; l++) {
        const h = headingsByLevel.get(l)
        if (h) parts.push(h)
      }
      currentHeading = line.trim()
      currentHeadingPath = parts.join(' > ')
      currentBody = []
      headingLine = i + 1
    } else {
      currentBody.push(line)
    }
  }

  if (currentBody.join('').trim()) {
    sections.push({
      headingAnchor: currentHeading,
      headingPath: currentHeadingPath,
      text: (currentHeading ? currentHeading + '\n\n' : '') + currentBody.join('\n').trim(),
      lineNumber: headingLine,
    })
  }

  if (sections.length === 0) {
    return [{ headingAnchor: '', headingPath: '', text: content.trim(), lineNumber: 1 }]
  }

  return sections
}
