export type ParsedText = {
  text: string
  lineNumber: 1
}

export function parseText(content: string): ParsedText {
  return { text: content.trim(), lineNumber: 1 }
}
