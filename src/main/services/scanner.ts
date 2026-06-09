import { readdir, stat } from 'fs/promises'
import { join, extname } from 'path'
import { createReadStream } from 'fs'
import { createHash } from 'crypto'

const SUPPORTED_EXTS = new Set([
  '.pdf',
  '.md',
  '.txt',
  // Code files — indexed via tree-sitter, falling back to text chunking if grammar unavailable
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.rb',
])
const IGNORED_DIRS = new Set(['.openbook', '.git', '.obsidian', 'node_modules'])
const MAX_FILE_BYTES = 50 * 1024 * 1024

export type ScannedFile = {
  path: string
  ext: string
  sizeBytes: number
}

export type ScanResult = {
  files: ScannedFile[]
  skipped: Array<{ path: string; reason: 'too_large' | 'permission_denied' }>
}

export async function scanFolder(folderPath: string): Promise<ScanResult> {
  const files: ScannedFile[] = []
  const skipped: ScanResult['skipped'] = []

  async function walk(dir: string, isRoot = false): Promise<void> {
    // @types/node v22 generic overload resolves to Dirent<NonSharedBuffer> via ReturnType<>;
    // spell out the concrete type that withFileTypes:true actually returns at runtime.
    let entries: import('fs').Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A read failure on the selected folder itself is almost always macOS
      // blocking access (TCC). Surface it so the UI can prompt a re-pick;
      // a single unreadable subdir deeper in the tree is silently skipped.
      if (isRoot)
        throw new Error(`FOLDER_UNREADABLE: Couldn't read "${dir}". macOS may be blocking access to this folder.`)
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(fullPath)
        continue
      }

      if (!entry.isFile()) continue

      const ext = extname(entry.name).toLowerCase()
      if (!SUPPORTED_EXTS.has(ext)) continue

      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(fullPath)
      } catch {
        skipped.push({ path: fullPath, reason: 'permission_denied' })
        continue
      }

      if (fileStat.size > MAX_FILE_BYTES) {
        skipped.push({ path: fullPath, reason: 'too_large' })
        continue
      }

      files.push({ path: fullPath, ext, sizeBytes: fileStat.size })
    }
  }

  await walk(folderPath, true)
  return { files, skipped }
}

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
