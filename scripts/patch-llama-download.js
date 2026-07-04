// Patches node-llama-cpp so `source download --release b8750` doesn't call the
// GitHub REST API.
//
// node-llama-cpp resolves every release tag through api.github.com before
// cloning, using an unauthenticated request with no way to pass a token.
// On shared CI runner IPs that request randomly fails with "API rate limit
// exceeded", which broke the v0.2.4 release build. The lookup is pointless
// when the release is already an exact tag (ours is pinned to b8750): the
// subsequent git clone doesn't need it and git isn't API rate-limited.
//
// Fix: short-circuit resolveGithubRelease() to return exact tags as-is.
// Must run BEFORE `npx node-llama-cpp source download` (unlike patch-llama.js,
// which patches the downloaded llama.cpp source afterwards).

const fs = require('fs')
const path = require('path')

const filePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-llama-cpp',
  'dist',
  'utils',
  'resolveGithubRelease.js'
)

if (!fs.existsSync(filePath)) {
  console.error('resolveGithubRelease.js not found — run npm install first')
  process.exit(1)
}

let content = fs.readFileSync(filePath, 'utf8')

const OLD = `export async function resolveGithubRelease(githubOwner, githubRepo, release) {
    const githubClient = new GitHubClient();`

const NEW = `export async function resolveGithubRelease(githubOwner, githubRepo, release) {
    if (release !== "latest")
        return release;
    const githubClient = new GitHubClient();`

if (content.includes(NEW)) {
  console.log('Patch already applied to resolveGithubRelease.js')
  process.exit(0)
}

if (!content.includes(OLD)) {
  console.error('Patch anchor not found in resolveGithubRelease.js — node-llama-cpp version changed?')
  process.exit(1)
}

content = content.replace(OLD, NEW)
fs.writeFileSync(filePath, content)
console.log('Applied GitHub API skip patch to resolveGithubRelease.js')
