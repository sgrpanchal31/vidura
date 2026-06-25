import { connect, type Connection, type Table } from '@lancedb/lancedb'
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from 'apache-arrow'
import { join } from 'path'
import { ensureOpenbookDir } from './state'
import type { Chunk } from './chunker'

const DEFAULT_LANCE_SUBDIR = join('.openbook', 'lance')
const TABLE_NAME = 'chunks'
export const EMBEDDING_DIM = 1024 // default; override via VectorStoreOptions.dim

export type VectorStoreOptions = {
  subdir?: string
  dim?: number
}

export type SearchResult = {
  id: string
  text: string // child chunk — what was matched
  parentText: string // parent unit — shown to the LLM for context
  parentId: string // shared across siblings from the same parent
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
      const vecField = tblSchema.fields.find((f) => f.name === 'vector')
      const storedDim: number | undefined = (vecField?.type as any)?.listSize
      // Drop and recreate if embedding dimension changed or schema is missing new fields
      const hasParentText = tblSchema.fields.some((f) => f.name === 'parentText')
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

  private mapRow(row: any, score: number): SearchResult {
    return {
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
      score,
    }
  }

  async search(queryVector: number[], topK = 8): Promise<SearchResult[]> {
    if (!this.table) throw new Error('VectorStore not open — call open() first')

    let rows: any[]
    try {
      // cast to any: lancedb type defs removed distanceType() from VectorQuery in a minor bump
      rows = await (this.table.search(queryVector) as any).distanceType('cosine').limit(topK).toArray()
    } catch {
      return []
    }

    return rows.map((row) =>
      // LanceDB cosine distance: 0 = identical, 2 = opposite; convert to [0,1] similarity
      this.mapRow(row, Math.max(0, 1 - (row._distance ?? 1)))
    )
  }

  // BM25 keyword search on the 'text' column. Score is set to 0 because RRF uses rank, not score.
  // Returns [] silently if no FTS index exists (old notebook) — searchHybrid degrades to dense-only.
  async searchFts(queryText: string, topK = 30): Promise<SearchResult[]> {
    if (!this.table) return []
    try {
      const rows = await (this.table.query() as any)
        .fullTextSearch(queryText, { columns: 'text' })
        .limit(topK)
        .toArray()
      return rows.map((row: any) => this.mapRow(row, 0))
    } catch {
      return []
    }
  }

  // Runs dense + BM25 in parallel and fuses results with Reciprocal Rank Fusion.
  async searchHybrid(queryVector: number[], queryText: string, topK = 30): Promise<SearchResult[]> {
    const [dense, sparse] = await Promise.all([this.search(queryVector, topK), this.searchFts(queryText, topK)])
    return reciprocalRankFusion([dense, sparse]).slice(0, topK)
  }

  // Creates (or rebuilds) the BM25 full-text index on the 'text' column.
  // Called once at the end of indexFolder() — replace:true makes it idempotent.
  async ensureFtsIndex(): Promise<void> {
    if (!this.table) return
    const { Index } = await import('@lancedb/lancedb')
    await (this.table as any).createIndex('text', {
      config: Index.fts({ language: 'English', stem: true }),
      replace: true,
    })
  }

  async listSourceFiles(): Promise<string[]> {
    if (!this.table) throw new Error('VectorStore not open — call open() first')
    try {
      const rows = await (this.table.query() as any).select(['sourceFile']).toArray()
      return Array.from(new Set(rows.map((r: any) => r.sourceFile as string)))
    } catch {
      return []
    }
  }

  async getChunksByFile(sourceFile: string): Promise<SearchResult[]> {
    if (!this.table) throw new Error('VectorStore not open — call open() first')
    try {
      const rows = await (this.table.query() as any).where(`sourceFile = '${sourceFile.replace(/'/g, "''")}'`).toArray()
      return rows.map((row: any) => ({
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
        score: 1,
      }))
    } catch {
      return []
    }
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

// Fuses multiple ranked result lists into one using Reciprocal Rank Fusion.
// k=60 is the standard constant; it dampens the bonus for very top ranks so
// a chunk appearing consistently across lists beats one that only tops one list.
function reciprocalRankFusion(lists: SearchResult[][], k = 60): SearchResult[] {
  const scores = new Map<string, number>()
  const byId = new Map<string, SearchResult>()
  for (const list of lists) {
    list.forEach((result, rank) => {
      scores.set(result.id, (scores.get(result.id) ?? 0) + 1 / (k + rank + 1))
      if (!byId.has(result.id)) byId.set(result.id, result)
    })
  }
  return [...byId.values()].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
}

export const vectorStore = new VectorStore()
