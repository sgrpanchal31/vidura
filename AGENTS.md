# Vidura

Local-first desktop app: chat with documents using an on-device LLM. Electron + React + TypeScript, built with electron-vite.

## Commits

- Short subject line only (no body, no bullet points)
- No `Co-Authored-By` lines — ever
- Example: `Fix chevron rotation in sources panel`

## Architecture

```
src/main/           — Electron main process
  index.ts          — IPC handlers, window setup
  services/
    models.ts       — GGUF download + validation
    embed.ts        — Embedding coordinator (talks to worker thread)
    inference.ts    — LLM via node-llama-cpp
    rag.ts          — embed → retrieve → prompt → stream → remap citations
    store.ts        — LanceDB vector store
    indexer.ts      — folder ingest orchestrator
    state.ts        — per-notebook state (.openbook/state.json)
    scanner.ts      — walks folder, finds .pdf/.md/.txt
    chunker.ts      — splits content into overlapping chunks
    ingest/         — pdf.ts, markdown.ts, text.ts parsers
  workers/embed.worker.ts — HuggingFace Transformers in Worker thread
src/preload/index.ts     — contextBridge API (types shared across all layers)
src/renderer/src/
  App.tsx           — screen router + onboarding/model-prep
  screens/Chat.tsx  — three-pane chat UI
  styles/globals.css — CSS tokens
```

## Key conventions

- **IPC**: new features need a handler in `main/index.ts`, exposure in `preload/index.ts`, type in `env.d.ts`
- **CSS tokens**: `--ink`, `--ox` (accent), `--slate`, `--cream-d/dd`, `--line/line-m` — never hardcode colors
- **Fonts**: IBM Plex Sans (UI), Source Serif 4 (editorial), IBM Plex Mono (code)
- **sourceFile** in chunks = relative path from notebook root, not absolute
- Build uses esbuild — TypeScript errors don't block `npm run build`

## Models (GGUF QAT Q4_0 / Q4_K_M, downloaded to userData/models/)

| modelId       | Model        | Size    |
| ------------- | ------------ | ------- |
| `gemma4-e2b`  | Gemma 4 E2B  | ~3.4 GB |
| `llama3.2-3b` | Llama 3.2 3B | ~2 GB   |
| `qwen2.5-7b`  | Qwen 2.5 7B  | ~4.7 GB |
| `gemma4-e4b`  | Gemma 4 E4B  | ~5.2 GB |
| `gemma4-12b`  | Gemma 4 12B  | ~7 GB   |

Embedding model (downloaded on first launch via HuggingFace Transformers, cached in userData/models/):

- `onnx-community/Qwen3-Embedding-0.6B-ONNX` — 1024-dim, ~600 MB, last-token pooling, multilingual
- Queries are prefixed with a retrieval instruction (`formatQueryForEmbed` in `rag.ts`); documents are embedded as-is

## Commands

```bash
npm install   # also runs electron-rebuild for @lancedb/lancedb
npm run dev
npm run build
```

## Workflow

Development follows an issue-driven flow documented in [docs/workflow.md](docs/workflow.md). When asked to work on an issue, follow it. Rules that always apply:

- **Branch from `dev`** — never commit directly to `main`. Feature branches: `feat/<issue#>-short-name`.
- **Before opening a PR**, run the `qa-reviewer` agent to check the diff against the issue's acceptance criteria.
- **Releases** (`dev → main`) go through the `release-gate` agent and require a version bump in `package.json`.
- Git hooks auto-format staged files on commit and run typecheck + tests on push. Don't bypass with `--no-verify` unless explicitly asked.
