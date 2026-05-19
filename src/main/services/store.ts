import { connect, type Connection, type Table } from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { join } from 'path'
import { ensureOpenbookDir } from './state'
import type { Chunk } from './chunker'

const LANCE_SUBDIR = join('.openbook', 'lance')
const TABLE_NAME = 'chunks'
const EMBEDDING_DIM = 384

export type SearchResult = {
  id: string
  text: string
  sourceFile: string
  chunkIndex: number
  pageNumber: number | undefined
  headingAnchor: string | undefined
  lineNumber: number | undefined
  score: number
}

const SCHEMA = new Schema([
  new Field('id', new Utf8(), false),
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), false)), false),
  new Field('text', new Utf8(), false),
  new Field('sourceFile', new Utf8(), false),
  new Field('chunkIndex', new Int32(), false),
  new Field('parserVersion', new Utf8(), false),
  new Field('pageNumber', new Int32(), true),
  new Field('headingAnchor', new Utf8(), true),
  new Field('lineNumber', new Int32(), true),
])

export class VectorStore {
  private db: Connection | null = null
  private table: Table | null = null
  private openFolderPath = ''

  async open(folderPath: string): Promise<void> {
    if (this.openFolderPath === folderPath && this.table) return

    await ensureOpenbookDir(folderPath)
    const dbPath = join(folderPath, LANCE_SUBDIR)

    this.db = await connect(dbPath)
    const names = await this.db.tableNames()

    if (names.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME)
    } else {
      this.table = await this.db.createEmptyTable(TABLE_NAME, SCHEMA)
    }

    this.openFolderPath = folderPath
  }

  async upsertChunks(chunks: Chunk[], vectors: number[][]): Promise<void> {
    if (!this.table) throw new Error('VectorStore not open — call open() first')
    if (chunks.length === 0) return

    // Delete stale rows for any file we're about to re-index
    const filesToReplace = [...new Set(chunks.map((c) => c.sourceFile))]
    for (const sf of filesToReplace) {
      await this.table.delete(`sourceFile = '${sf.replace(/'/g, "''")}'`)
    }

    const rows = chunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      text: c.text,
      sourceFile: c.sourceFile,
      chunkIndex: c.chunkIndex,
      parserVersion: c.parserVersion,
      pageNumber: c.pageNumber ?? null,
      headingAnchor: c.headingAnchor ?? null,
      lineNumber: c.lineNumber ?? null,
    }))

    await this.table.add(rows)
  }

  async deleteByFiles(relPaths: string[]): Promise<void> {
    if (!this.table || relPaths.length === 0) return
    for (const rp of relPaths) {
      await this.table.delete(`sourceFile = '${rp.replace(/'/g, "''")}'`)
    }
  }

  async search(queryVector: number[], topK = 8): Promise<SearchResult[]> {
    if (!this.table) throw new Error('VectorStore not open — call open() first')

    let rows: any[]
    try {
      rows = await this.table
        .search(queryVector)
        .distanceType('cosine')
        .limit(topK)
        .toArray()
    } catch {
      // Table is empty or index not yet built — return nothing
      return []
    }

    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      sourceFile: row.sourceFile as string,
      chunkIndex: row.chunkIndex as number,
      pageNumber: row.pageNumber ?? undefined,
      headingAnchor: row.headingAnchor ?? undefined,
      lineNumber: row.lineNumber ?? undefined,
      // LanceDB cosine distance: 0 = identical, 2 = opposite; convert to [0,1] similarity
      score: Math.max(0, 1 - (row._distance ?? 1)),
    }))
  }

  isOpen(): boolean {
    return this.table !== null
  }
}

export const vectorStore = new VectorStore()
