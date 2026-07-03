import { readFile } from 'fs/promises'
import { relative } from 'path'
import { scanFolder, hashFile } from './scanner'
import { parsePdf } from './ingest/pdf'
import { parseMarkdown } from './ingest/markdown'
import { parseText } from './ingest/text'
import { parseCode } from './ingest/code'
import { chunkPdf, chunkMarkdown, chunkText, chunkCode, PARSER_VERSION, type Chunk } from './chunker'
import { readState, writeState, type NotebookState } from './state'
import { embedService } from './embed'
import { vectorStore } from './store'
import { DEFAULT_EMBED, embedDim } from './embed-models'

export type IndexProgress = {
  stage: 'scanning' | 'hashing' | 'parsing' | 'model_load' | 'embedding' | 'done'
  processed: number
  total: number
  currentFile?: string
}

export type IndexSummary = {
  total: number // files found in folder
  indexed: number // newly indexed this run
  upToDate: number // already indexed, hash unchanged
  failed: number // parse errors + oversized
  chunks: number // new chunks from this run
  totalChunks: number // total chunks across all indexed files
}

export async function indexFolder(
  folderPath: string,
  onProgress: (p: IndexProgress) => void,
  embeddingModel?: string
): Promise<{ summary: IndexSummary; chunks: Chunk[] }> {
  onProgress({ stage: 'scanning', processed: 0, total: 0 })

  const { files, skipped } = await scanFolder(folderPath)
  const state = await readState(folderPath)

  // Always use the single current model; ignore stale state.embeddingModel from old notebooks
  const effectiveModel = embeddingModel ?? DEFAULT_EMBED

  const newState: NotebookState = { version: 1, embeddingModel: effectiveModel, files: { ...state.files } }

  onProgress({ stage: 'hashing', processed: 0, total: files.length })

  type Work = { path: string; ext: string; hash: string; relPath: string }
  const toIndex: Work[] = []
  const unchanged: string[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress({ stage: 'hashing', processed: i, total: files.length, currentFile: file.path })
    let hash: string
    try {
      hash = await hashFile(file.path)
    } catch {
      newState.files[relative(folderPath, file.path)] = {
        relativePath: relative(folderPath, file.path),
        hash: '',
        lastIndexed: Date.now(),
        chunkCount: 0,
        failed: true,
        failReason: 'hash_error',
      }
      continue
    }

    const relPath = relative(folderPath, file.path)
    const existing = state.files[relPath]
    const alreadyEmbedded = existing?.embeddingModel === effectiveModel
    const currentParser = existing?.parserVersion === PARSER_VERSION
    if (existing && existing.hash === hash && !existing.failed && alreadyEmbedded && currentParser) {
      unchanged.push(relPath)
    } else {
      toIndex.push({ path: file.path, ext: file.ext, hash, relPath })
    }
  }

  // Remove deleted files from state
  for (const relPath of Object.keys(newState.files)) {
    if (!files.some((f) => relative(folderPath, f.path) === relPath)) {
      delete newState.files[relPath]
    }
  }

  const allChunks: Chunk[] = []
  let failCount = 0

  onProgress({ stage: 'parsing', processed: 0, total: toIndex.length })

  for (let i = 0; i < toIndex.length; i++) {
    const { path, ext, hash, relPath } = toIndex[i]
    onProgress({ stage: 'parsing', processed: i, total: toIndex.length, currentFile: relPath })

    try {
      let chunks: Chunk[] = []

      if (ext === '.pdf') {
        const parsed = await parsePdf(path)
        chunks = chunkPdf(relPath, parsed.pages)
      } else if (ext === '.md') {
        const content = await readFile(path, 'utf-8')
        const sections = parseMarkdown(content)
        chunks = chunkMarkdown(relPath, sections)
      } else if (
        ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb'].includes(ext)
      ) {
        const content = await readFile(path, 'utf-8')
        const symbols = await parseCode(path, content)
        if (symbols.length > 0) {
          chunks = chunkCode(relPath, symbols)
        } else {
          // Fall back to text chunking if tree-sitter parse produced no symbols
          chunks = chunkText(relPath, parseText(content))
        }
      } else {
        const content = await readFile(path, 'utf-8')
        const parsed = parseText(content)
        chunks = chunkText(relPath, parsed)
      }

      allChunks.push(...chunks)
      newState.files[relPath] = {
        relativePath: relPath,
        hash,
        lastIndexed: Date.now(),
        chunkCount: chunks.length,
        parserVersion: PARSER_VERSION,
      }
    } catch (err) {
      failCount++
      newState.files[relPath] = {
        relativePath: relPath,
        hash,
        lastIndexed: Date.now(),
        chunkCount: 0,
        failed: true,
        failReason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Embedding + vector store write
  const dim = embedDim(effectiveModel)
  if (allChunks.length > 0) {
    await vectorStore.open(folderPath, { dim })

    // Start embed worker — may download model on first run; emit model_load progress
    onProgress({ stage: 'model_load', processed: 0, total: 0 })
    await embedService.start(
      (loaded, total) => {
        onProgress({ stage: 'model_load', processed: loaded, total })
      },
      { modelId: effectiveModel }
    )

    onProgress({ stage: 'embedding', processed: 0, total: allChunks.length })

    // Embed and persist one source file at a time so a crash mid-index leaves
    // completed files stamped in state.json and won't be re-embedded on restart.
    const chunksByFile = new Map<string, Chunk[]>()
    for (const chunk of allChunks) {
      const arr = chunksByFile.get(chunk.sourceFile) ?? []
      arr.push(chunk)
      chunksByFile.set(chunk.sourceFile, arr)
    }

    let embeddedSoFar = 0
    for (const [sourceFile, chunks] of chunksByFile) {
      const vectors = await embedService.embedBatched(
        chunks.map((c) => c.text),
        (done) => onProgress({ stage: 'embedding', processed: embeddedSoFar + done, total: allChunks.length })
      )
      await vectorStore.upsertChunks(chunks, vectors)

      // Stamp this file as embedded and persist immediately so a crash here
      // won't re-embed it on the next launch.
      const rec = newState.files[sourceFile]
      if (rec) rec.embeddingModel = effectiveModel
      await writeState(folderPath, newState)

      embeddedSoFar += chunks.length
    }

    await vectorStore.ensureFtsIndex()
  } else if (toIndex.length === 0) {
    // Nothing new to index — still need the store open for search
    await vectorStore.open(folderPath, { dim })
  }

  // Remove vector rows for files deleted since last index
  const deletedRelPaths = Object.keys(state.files).filter((rp) => !newState.files[rp])
  if (deletedRelPaths.length > 0 && vectorStore.isOpen()) {
    await vectorStore.deleteByFiles(deletedRelPaths)
  }

  await writeState(folderPath, newState)

  onProgress({ stage: 'done', processed: toIndex.length, total: toIndex.length })

  const totalChunks = Object.values(newState.files)
    .filter((f) => !f.failed)
    .reduce((sum, f) => sum + f.chunkCount, 0)

  return {
    summary: {
      total: files.length,
      indexed: toIndex.length - failCount,
      upToDate: unchanged.length,
      failed: failCount + skipped.length,
      chunks: allChunks.length,
      totalChunks,
    },
    chunks: allChunks,
  }
}
