# openbook-lm — Claude Code Guide

## What this is
Local-first desktop app (Electron + React + TypeScript) that lets you chat with your documents using a locally-running LLM. No cloud, no API keys. Built with electron-vite.

## Architecture

```
src/
  main/           — Electron main process (Node.js)
    index.ts      — App entry, IPC handlers, window setup
    services/
      models.ts   — GGUF model download + validation
      embed.ts    — Embedding service coordinator (talks to worker)
      inference.ts — LLM inference via node-llama-cpp
      rag.ts      — Full RAG pipeline (embed → retrieve → prompt → stream)
      store.ts    — LanceDB vector store (open, insert, search)
      indexer.ts  — Orchestrates ingest for a folder
      state.ts    — Persists per-notebook index state (.openbook/state.json)
      scanner.ts  — Walks folder, finds .pdf/.md/.txt files
      chunker.ts  — Splits parsed content into overlapping chunks
      ingest/
        pdf.ts    — PDF parsing via pdfjs-dist
        markdown.ts — Markdown parsing
        text.ts   — Plain text parsing
    workers/
      embed.worker.ts — Runs HuggingFace Transformers in a Worker thread
  preload/
    index.ts      — contextBridge API (types exported for renderer + env.d.ts)
  renderer/
    src/
      App.tsx     — Screen router + onboarding/model-prep flows
      screens/
        Onboarding.tsx / .css  — First-run flow
        Chat.tsx / .css        — Three-pane chat UI
      styles/globals.css       — CSS tokens (--ink, --ox, --cream-d, etc.)
```

## Key conventions

- **IPC**: All main↔renderer communication goes through `window.api` (contextBridge). New features need: IPC handler in `main/index.ts`, API exposure in `preload/index.ts`, type in `env.d.ts`.
- **Types**: Types shared across main/preload/renderer are exported from `src/preload/index.ts`.
- **CSS tokens**: Use vars from `globals.css`. Never hardcode colors. `--ink` (text), `--ox` (accent/citations), `--slate` (secondary), `--cream-d` / `--cream-dd` (backgrounds), `--line` / `--line-m` (borders).
- **Fonts**: `'IBM Plex Sans'` (UI), `'Source Serif 4'` (editorial/empty states), `'IBM Plex Mono'` (code).
- **No TypeScript errors block build**: electron-vite uses esbuild, which skips type checking. Run `tsc --noEmit` separately if needed.
- **sourceFile in chunks** = relative path from notebook folder root (not absolute). Used as the equality key in citation matching.

## Build & dev

```bash
npm install          # also runs electron-rebuild for @lancedb/lancedb
npm run dev          # hot-reload dev mode
npm run build        # production build → out/
```

## Models

LLM models are GGUF Q4_K_M quantizations, downloaded to `~/Library/Application Support/openbook-lm/models/` (macOS).

| modelId | Actual model | Size |
|---|---|---|
| `gemma2-2b` | Qwen 2.5 1.5B Instruct | ~986 MB |
| `llama3.2-3b` | Llama 3.2 3B Instruct | ~2 GB |
| `qwen2.5-7b` | Qwen 2.5 7B Instruct | ~4.7 GB |
| `phi3-mini` | Phi-3 Mini 4K Instruct | ~2.2 GB |

Embedding model: `Xenova/bge-small-en-v1.5` (384-dim, q8, ~23 MB) — downloaded via HuggingFace Transformers on first use.

## RAG pipeline

1. Embed query → 384-dim vector (bge-small-en-v1.5)
2. ANN search in LanceDB → top 5 chunks
3. Build system prompt with numbered sources [1]–[5], truncated to 800 chars each
4. Stream LLM response via node-llama-cpp
5. Post-process: remap citation numbers [4] → [1] based on order of appearance
6. Return `{ answer, citations[] }` to renderer

## TODOS.md
Tracks deferred work. Check before implementing features — some have architecture notes that affect the approach.
