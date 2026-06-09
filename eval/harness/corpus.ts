import { join, relative, extname } from 'path'
import { readdirSync, statSync, mkdirSync, existsSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { connect } from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { embedTexts, EVAL_EMBEDDING_DIM } from './embedder'
import { chunkPdf, chunkMarkdown, chunkText } from '../../src/main/services/chunker'
import { parsePdf } from '../../src/main/services/ingest/pdf'
import { parseMarkdown } from '../../src/main/services/ingest/markdown'
import { parseText } from '../../src/main/services/ingest/text'
import type { ChunkConfig } from '../../src/main/services/chunker'

const TABLE_NAME = 'chunks'
const SCHEMA = new Schema([
  new Field('id', new Utf8(), false),
  new Field('vector', new FixedSizeList(EVAL_EMBEDDING_DIM, new Field('item', new Float32(), false)), false),
  new Field('text', new Utf8(), false),
  new Field('parentText', new Utf8(), false),
  new Field('parentId', new Utf8(), false),
  new Field('sourceFile', new Utf8(), false),
  new Field('chunkIndex', new Int32(), false),
  new Field('pageNumber', new Int32(), true),
  new Field('headingAnchor', new Utf8(), true),
  new Field('headingPath', new Utf8(), true),
  new Field('lineNumber', new Int32(), true),
])

export async function buildCorpusIndex(corpusDir: string, workDir: string, cfg?: ChunkConfig): Promise<void> {
  const indexPath = join(workDir, 'lance')
  const doneFlag = join(workDir, '.indexed')

  if (existsSync(doneFlag)) {
    console.log(`  [corpus] index exists at ${workDir}, skipping`)
    return
  }

  mkdirSync(indexPath, { recursive: true })
  const db = await connect(indexPath)
  const names = await db.tableNames()
  const table = names.includes(TABLE_NAME)
    ? await db.openTable(TABLE_NAME)
    : await db.createEmptyTable(TABLE_NAME, SCHEMA)

  const files = walkDir(corpusDir).filter((f) => ['.pdf', '.md', '.txt'].includes(extname(f).toLowerCase()))
  console.log(`  [corpus] indexing ${files.length} files from ${corpusDir}`)

  for (const absPath of files) {
    const relPath = relative(corpusDir, absPath)
    const ext = extname(absPath).toLowerCase()

    try {
      let chunks: ReturnType<typeof chunkText>

      if (ext === '.pdf') {
        const parsed = await parsePdf(absPath)
        chunks = chunkPdf(relPath, parsed.pages, cfg)
      } else if (ext === '.md') {
        const content = await readFile(absPath, 'utf-8')
        const sections = parseMarkdown(content)
        chunks = chunkMarkdown(relPath, sections, cfg)
      } else {
        const content = await readFile(absPath, 'utf-8')
        const parsed = parseText(content)
        chunks = chunkText(relPath, parsed, cfg)
      }

      if (chunks.length === 0) continue

      process.stdout.write(`  [corpus] ${relPath} (${chunks.length} chunks)...`)
      const vectors = await embedTexts(chunks.map((c) => c.text))
      console.log(' done')

      await table.add(
        chunks.map((c, i) => ({
          id: c.id,
          vector: vectors[i],
          text: c.text,
          parentText: c.parentText,
          parentId: c.parentId,
          sourceFile: c.sourceFile,
          chunkIndex: c.chunkIndex,
          pageNumber: c.pageNumber ?? null,
          headingAnchor: c.headingAnchor ?? null,
          headingPath: c.headingPath ?? null,
          lineNumber: c.lineNumber ?? null,
        }))
      )
    } catch (e) {
      console.warn(`  [corpus] skipping ${relPath}: ${e}`)
    }
  }

  writeFileSync(doneFlag, new Date().toISOString())
  console.log(`  [corpus] done`)
}

export async function openCorpusTable(workDir: string) {
  const db = await connect(join(workDir, 'lance'))
  return db.openTable(TABLE_NAME)
}

function walkDir(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath))
    } else if (stat.isFile() && stat.size < 50 * 1024 * 1024) {
      results.push(fullPath)
    }
  }
  return results
}
