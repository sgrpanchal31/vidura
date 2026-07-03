import chokidar from 'chokidar'
import { extname } from 'path'

const SUPPORTED_EXTS = new Set([
  '.pdf',
  '.md',
  '.txt',
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

class FolderWatcher {
  private watcher: chokidar.FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  start(folderPath: string, onChanged: () => void): void {
    this.stop()
    this.watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      ignored: /(\.openbook|\.git|node_modules)/,
      persistent: true,
    })

    const debounced = () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(onChanged, 2000)
    }

    const handle = (filePath: string) => {
      if (SUPPORTED_EXTS.has(extname(filePath).toLowerCase())) debounced()
    }

    this.watcher.on('add', handle).on('change', handle).on('unlink', handle)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}

export const folderWatcher = new FolderWatcher()
