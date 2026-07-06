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
    inference.ts    — LLM via node-llama-cpp (generateStream + agent sessions)
    agent/          — chat pipeline: orchestrator loop, tool registry, tools/
                      (grammar-constrained decisions; see decision log in issue #55)
    rag.ts          — retrieval primitives (retrieve/rerank/dedupe) + legacy pipeline
                      behind prefs.agentEnabled=false + podcast/overview prompts
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
- **Native ML runtimes must not share the Electron main process** — kokoro-js and the embed worker bundle different onnxruntime versions, and two copies in one address space segfault the app. TTS runs in a `utilityProcess`; keep any future native-heavy engine in its own process too.

## Models (GGUF QAT Q4_0 / Q4_K_M, downloaded to userData/models/)

| modelId       | Model        | Size     |
| ------------- | ------------ | -------- |
| `gemma4-e2b`  | Gemma 4 E2B  | ~3.4 GB  |
| `llama3.2-3b` | Llama 3.2 3B | ~2 GB    |
| `gemma4-e4b`  | Gemma 4 E4B  | ~5.2 GB  |
| `gemma4-12b`  | Gemma 4 12B  | ~7 GB    |
| `gpt-oss-20b` | GPT-OSS 20B  | ~11.6 GB |

Embedding model (downloaded on first launch via HuggingFace Transformers, cached in userData/models/):

- `onnx-community/Qwen3-Embedding-0.6B-ONNX` — 1024-dim, ~600 MB, last-token pooling, multilingual
- Queries are prefixed with a retrieval instruction (`formatQueryForEmbed` in `rag.ts`); documents are embedded as-is

## Commands

```bash
npm install          # also runs electron-rebuild for @lancedb/lancedb
npm run llama:update # download llama.cpp b8750, apply Gemma 4 E4B patch, compile (takes ~5 min)
npm run dev
npm run build
```

## UX design principles

Every UI feature should be designed with the mental model of how users behave in mature apps. Before implementing, ask: what does the user expect based on every other app they use?

Key patterns to always consider:

- **Don't destroy typed text.** If the user typed something and clicked a navigation item, that text must survive. Use draft refs keyed by session or context. Examples: clicking "New Chat" when already on a blank chat should focus, not reset; switching between Chat and Podcast tiles should swap drafts, not wipe them.
- **Background work keeps running.** If a long operation (generation, download) is in progress and the user navigates away, it should continue. Don't unmount the component doing the work — hide it with `display: none` instead. When the user returns, they see the result.
- **Only one generation at a time, but free navigation.** Block the send action during generation, not the ability to browse or type. Users expect to be able to read other sessions while waiting.
- **Indicate state where the work is happening, not just where the user is.** If session A is generating and the user is viewing session B, the sidebar must show which session is generating (spinner dot). Don't just disable global UI — point to the specific item.
- **Disabled visual state should not inadvertently reveal hidden elements.** CSS `:disabled` can override `opacity: 0` rules and make previously invisible elements appear. Always check `:disabled` overrides when adding disabled states to elements that are hidden by default.
- **Navigation guards should be minimal.** Only block navigation if it would cause data loss or two parallel conflicting operations. "User is generating" is not a reason to block switching sessions — it's a reason to block starting another generation.

## Writing style

- No em-dashes in any user-facing text (README, release notes, UI copy). Use commas or colons instead. Em-dashes are fine in code comments and internal docs like this file.

## Workflow

Development follows an issue-driven flow documented in [docs/workflow.md](docs/workflow.md). When asked to work on an issue, follow it. Rules that always apply:

- **Branch from `dev`** — never commit directly to `main`. Feature branches: `feat/<issue#>-short-name`.
- **Before opening a PR**, run the `qa-reviewer` agent to check the diff against the issue's acceptance criteria.
- **Releases** (`dev → main`) go through the `release-gate` agent and require a version bump in `package.json`.
- Git hooks auto-format staged files on commit and run typecheck + tests on push. Don't bypass with `--no-verify` unless explicitly asked.
