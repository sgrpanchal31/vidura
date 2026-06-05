/**
 * Downloads LongMemEval dataset files from HuggingFace.
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval
 *
 * Available variants (choose one to start with):
 *   longmemeval_oracle  — 15MB. Tiny haystack (~2 sessions/question). Good for testing
 *                         the harness is wired correctly. Recall will be near 100% because
 *                         there are almost no distractor sessions — not a realistic benchmark.
 *   longmemeval_s       — 278MB. ~115 sessions per question. The real benchmark.
 *                         This is what MemPalace / GBrain report R@5 against.
 *   longmemeval_m       — 2.7GB. Larger haystack. Skip for now.
 *
 * Usage:
 *   npm run eval -- --download                    (downloads oracle only)
 *   npm run eval -- --download --variant s        (downloads longmemeval_s, 278MB)
 */

import { join } from 'path'
import { mkdirSync, existsSync, createWriteStream } from 'fs'
import { get as httpsGet } from 'https'
import { IncomingMessage } from 'http'

export const DATA_DIR = join(process.cwd(), 'eval', 'datasets', 'longmemeval', 'data')

const HF_BASE = 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main'

export function dataPath(variant: string): string {
  return join(DATA_DIR, `longmemeval_${variant}`)
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    file.on('error', reject)

    function follow(u: string, hops = 0) {
      if (hops > 5) { reject(new Error('Too many redirects')); return }
      httpsGet(u, (res: IncomingMessage) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Drain the redirect response body before following
          res.resume()
          follow(res.headers.location!, hops + 1)
          return
        }
        if (res.statusCode !== 200) {
          file.close()
          reject(new Error(`HTTP ${res.statusCode} for ${u}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let downloaded = 0
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(1)
            process.stdout.write(`  ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)\r`)
          }
        })
        res.pipe(file)
        file.on('finish', () => { console.log(''); resolve() })
      }).on('error', (err: Error) => { file.close(); reject(err) })
    }

    follow(url)
  })
}

export async function downloadLongMemEval(variant = 'oracle'): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  const dest = dataPath(variant)
  if (existsSync(dest)) {
    console.log(`[download] already exists: ${dest}`)
    return
  }
  const url = `${HF_BASE}/longmemeval_${variant}`
  console.log(`[download] fetching ${url}  (${variant === 'oracle' ? '~15MB' : variant === 's' ? '~278MB' : '~2.7GB'})`)
  await downloadFile(url, dest)
  console.log(`[download] saved to ${dest}`)
}
