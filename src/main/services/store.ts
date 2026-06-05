import { connect, type Connection, type Table } from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { join } from 'path'
import { ensureOpenbookDir } from './state'
import type { Chunk } from './chunker'

const DEFAULT_LANCE_SUBDIR = join('.openbook', 'lance')
const TABLE_NAME = 'chunks'
export const EMBEDDING_DIM = 1024  // default; override via VectorStoreOptions.dim

export type VectorStoreOptions = {
  subdir?: string
  dim?: number
}

export type SearchResult = {
  id: string
  text: string           // child chunk — what was matched
  parentText: string     // parent unit — shown to the LLM for context
  parentId: string       // shared across siblings from the same parent
  sourceFile: string
  chunkIndex: number
  pageNumber: number | undefined
  headingAnchor: string | undefined
  headingPath: string | undefined
  lineNumber: number | undefined
  score: number
}

function makeSchema(dim: number): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('vector', new FixedSizeList(dim, new Field('item', new Float32(), false)), false),
    new Field('text', new Utf8(), false),
    new Field('parentText', new Utf8(), false),
    new Field('parentId', new Utf8(), false),
    new Field('sourceFile', new Utf8(), false),
    new Field('chunkIndex', new Int32(), false),
    new Field('parserVersion', new Utf8(), false),
    new Field('pageNumber', new Int32(), true),
    new Field('headingAnchor', new Utf8(), true),
    new Field('headingPath', new Utf8(), true),
    new Field('lineNumber', new Int32(), true),
  ])
}

export class VectorStore {
  private db: Connection | null = null
  private table: Table | null = null
  private openKey = ''

  async open(folderPath: string, opts?: VectorStoreOptions): Promise<void> {
    const subdir = opts?.subdir ?? DEFAULT_LANCE_SUBDIR
    const dim = opts?.dim ?? EMBEDDING_DIM
    const key = `${folderPath}::${subdir}::${dim}`
    if (this.openKey === key && this.table) return

    await ensureOpenbookDir(folderPath)
    const dbPath = join(folderPath, subdir)
    const schema = makeSchema(dim)

    this.db = await connect(dbPath)
    const names = await this.db.tableNames()

    if (names.includes(TABLE_NAME)) {
      const tbl = await this.db.openTable(TABLE_NAME)
      const tblSchema = await tbl.schema()
      const vecField = tblSchema.fields.find(f => f.name === 'vector')
      const storedDim: number | undefined = (vecField?.type as any)?.listSize
      // Drop and recreate if embedding dimension changed or schema is missing new fields
      const hasParentText = tblSchema.fields.some(f => f.name === 'parentText')
      if ((storedDim !== undefined && storedDim !== dim) || !hasParentText) {
        await this.db.dropTable(TABLE_NAME)
        this.table = await this.db.createEmptyTable(TABLE_NAME, schema)
      } else {
        this.table = tbl
      }
    } else {
      this.table = await this.db.createEmptyTable(TABLE_NAME, schema)
    }

    this.openKey = key
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
      parentText: c.parentText,
      parentId: c.parentId,
      sourceFile: c.sourceFile,
      chunkIndex: c.chunkIndex,
      parserVersion: c.parserVersion,
      pageNumber: c.pageNumber ?? null,
      headingAnchor: c.headingAnchor ?? null,
      headingPath: c.headingPath ?? null,
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
      return []
    }

    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      parentText: row.parentText as string,
      parentId: row.parentId as string,
      sourceFile: row.sourceFile as string,
      chunkIndex: row.chunkIndex as number,
      pageNumber: row.pageNumber ?? undefined,
      headingAnchor: row.headingAnchor ?? undefined,
      headingPath: row.headingPath ?? undefined,
      lineNumber: row.lineNumber ?? undefined,
      // LanceDB cosine distance: 0 = identical, 2 = opposite; convert to [0,1] similarity
      score: Math.max(0, 1 - (row._distance ?? 1)),
    }))
  }

  isOpen(): boolean {
    return this.table !== null
  }

  async close(): Promise<void> {
    this.table = null
    this.db = null
    this.openKey = ''
  }
}

export const vectorStore = new VectorStore()
