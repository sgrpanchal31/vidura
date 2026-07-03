import { readFile } from 'fs/promises'

export type PdfPage = {
  pageNumber: number
  text: string
}

export type ParsedPdf = {
  pages: PdfPage[]
}

export async function parsePdf(filePath: string): Promise<ParsedPdf> {
  const buffer = await readFile(filePath)

  // Dynamic import required: pdfjs-dist v5 is ESM-only; CJS main process must use import().
  // Cast: the legacy build's .d.ts lags its .mjs runtime (getDocument is missing from the
  // types even though it exists at runtime), so the module is typed as any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  })

  const pdfDocument = await loadingTask.promise
  const pages: PdfPage[] = []

  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const page = await pdfDocument.getPage(i)
    const textContent = await page.getTextContent()
    let lastY = -Infinity
    let text = ''
    for (const item of textContent.items as Array<{ str: string; transform: number[] }>) {
      const y = item.transform[5]
      if (lastY !== -Infinity && Math.abs(y - lastY) > 4) text += '\n'
      text += item.str
      lastY = y
    }
    if (text.trim()) pages.push({ pageNumber: i, text: text.trim() })
    page.cleanup()
  }

  await pdfDocument.destroy()
  return { pages }
}
