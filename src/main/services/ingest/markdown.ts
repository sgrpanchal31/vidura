export type MarkdownSection = {
  headingAnchor: string
  text: string
  lineNumber: number
}

export function parseMarkdown(content: string): MarkdownSection[] {
  const lines = content.split('\n')
  const sections: MarkdownSection[] = []
  let currentHeading = ''
  let currentBody: string[] = []
  let headingLine = 1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) {
      if (currentBody.join('').trim()) {
        sections.push({
          headingAnchor: currentHeading,
          text: currentBody.join('\n').trim(),
          lineNumber: headingLine
        })
      }
      currentHeading = line.trim()
      currentBody = []
      headingLine = i + 1
    } else {
      currentBody.push(line)
    }
  }

  if (currentBody.join('').trim()) {
    sections.push({
      headingAnchor: currentHeading,
      text: currentBody.join('\n').trim(),
      lineNumber: headingLine
    })
  }

  if (sections.length === 0) {
    return [{ headingAnchor: '', text: content.trim(), lineNumber: 1 }]
  }

  return sections
}
