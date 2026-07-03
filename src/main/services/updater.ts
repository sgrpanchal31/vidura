import { app, net } from 'electron'
import { join } from 'path'
import os from 'os'
import { createWriteStream } from 'fs'
import { writeFile, chmod, mkdtemp } from 'fs/promises'
import { spawn } from 'child_process'
import { isNewerVersion } from './version'

// The app is ad-hoc signed, so Squirrel/electron-updater would refuse to install
// updates. Instead we do exactly what scripts/install.sh does: download the DMG,
// swap the bundle in /Applications, relaunch. The swap runs in a detached shell
// script AFTER the app quits (replacing a running app and calling `open` would
// just refocus the old instance).
const RELEASES_API = 'https://api.github.com/repos/sgrpanchal31/vidura/releases/latest'
const DMG_ASSET = 'vidura-arm64.dmg'
const INSTALL_PATH = '/Applications/Vidura.app'

export type UpdateInfo = { version: string; url: string }

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      let body = ''
      response.on('data', (chunk) => (body += chunk.toString()))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

// Returns the newer release if one exists; null on "up to date" or ANY error.
// The updater must never block or break the app.
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const release = (await fetchJson(RELEASES_API)) as any
    const version = String(release?.tag_name ?? '').replace(/^v/, '')
    if (!version || !isNewerVersion(version, app.getVersion())) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asset = (release?.assets ?? []).find((a: any) => a?.name === DMG_ASSET)
    if (!asset?.browser_download_url) return null
    return { version, url: asset.browser_download_url }
  } catch {
    return null
  }
}

function downloadFile(url: string, dest: string, onProgress: (loaded: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request(url) // Electron net follows the GitHub → CDN redirect
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} downloading update`))
        return
      }
      const total = parseInt((response.headers['content-length'] as string) ?? '0', 10)
      const out = createWriteStream(dest)
      let loaded = 0
      response.on('data', (chunk: Buffer) => {
        loaded += chunk.length
        out.write(chunk)
        onProgress(loaded, total)
      })
      response.on('end', () => out.end(() => resolve()))
      response.on('error', (err) => {
        out.destroy()
        reject(err)
      })
    })
    request.on('error', reject)
    request.end()
  })
}

// Downloads the DMG, spawns the detached swap script, and quits the app.
// The script waits for this process to exit before touching /Applications.
export async function downloadAndInstall(
  url: string,
  onProgress: (loaded: number, total: number) => void
): Promise<void> {
  const workDir = await mkdtemp(join(os.tmpdir(), 'vidura-update-'))
  const dmgPath = join(workDir, DMG_ASSET)
  await downloadFile(url, dmgPath, onProgress)

  const script = `#!/bin/bash
# Vidura self-update: runs detached after the app quits
set -e
# Wait (up to 30s) for the app process to exit
for i in $(seq 1 60); do
  kill -0 ${process.pid} 2>/dev/null || break
  sleep 0.5
done
MOUNT="${workDir}/mount"
mkdir -p "$MOUNT"
hdiutil attach "${dmgPath}" -nobrowse -quiet -mountpoint "$MOUNT"
rm -rf "${INSTALL_PATH}"
ditto "$MOUNT/Vidura.app" "${INSTALL_PATH}"
xattr -cr "${INSTALL_PATH}"
hdiutil detach "$MOUNT" -quiet || true
rm -rf "${workDir}"
open -n "${INSTALL_PATH}"
`
  const scriptPath = join(workDir, 'update.sh')
  await writeFile(scriptPath, script, 'utf-8')
  await chmod(scriptPath, 0o755)
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}
