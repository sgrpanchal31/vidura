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
          // Prepend the heading so embeddings capture section context ("What Claude is here for"
          // must be in the text or queries referencing the heading won't match the chunk).
          text: (currentHeading ? currentHeading + '\n\n' : '') + currentBody.join('\n').trim(),
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
      text: (currentHeading ? currentHeading + '\n\n' : '') + currentBody.join('\n').trim(),
      lineNumber: headingLine
    })
  }

  if (sections.length === 0) {
    return [{ headingAnchor: '', text: content.trim(), lineNumber: 1 }]
  }

  return sections
}
