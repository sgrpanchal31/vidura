# openbook-lm

An open-source, local-first alternative to NotebookLM. Point it at a folder of documents, pick a model, and chat with your sources — fully on-device, no API keys, no cloud.

---

## What it does

- **Indexes your documents** — PDF, Markdown, and plain text files
- **Cited answers** — every response links back to the exact passage it came from
- **Runs entirely offline** — LLM inference and embeddings happen on your machine
- **Multi-turn chat** — conversation history stays in context across messages

---

## Supported platforms

| Platform              | Status                                                |
| --------------------- | ----------------------------------------------------- |
| macOS (Apple Silicon) | Supported                                             |
| macOS (Intel)         | Supported                                             |
| Windows               | Supported (builds and runs; UI uses native title bar) |
| Linux                 | Not tested                                            |

> **Note:** Apple Silicon Macs get the best performance — node-llama-cpp uses Metal GPU acceleration automatically. Intel Macs and Windows fall back to CPU inference, which is slower.

---

## System requirements

|         | Minimum                 | Recommended |
| ------- | ----------------------- | ----------- |
| RAM     | 8 GB                    | 16 GB+      |
| Disk    | 5 GB free               | 10 GB+ free |
| OS      | macOS 12+ / Windows 10+ | macOS 13+   |
| Node.js | 18+                     | 20+         |

More RAM allows larger models. The 7B model needs ~6 GB RAM headroom during inference.

---

## Models

During setup you choose one LLM. All models are GGUF Q4_K_M quantizations (4-bit, good quality/speed tradeoff) downloaded from HuggingFace.

| Label        | Underlying model       | Download size | Best for                              |
| ------------ | ---------------------- | ------------- | ------------------------------------- |
| Gemma 2 2B   | Qwen 2.5 1.5B Instruct | ~1 GB         | Fast answers, low RAM (8 GB machines) |
| Llama 3.2 3B | Llama 3.2 3B Instruct  | ~2 GB         | Better reasoning, still quick         |
| Qwen 2.5 7B  | Qwen 2.5 7B Instruct   | ~4.7 GB       | Best quality (needs 16 GB RAM)        |
| Phi-3 Mini   | Phi-3 Mini 4K Instruct | ~2.2 GB       | Strong on technical/code content      |

**Embedding model:** `bge-small-en-v1.5` (~23 MB) — downloaded automatically on first run. Used to turn documents and queries into vectors for semantic search.

Models are stored in your system's app data folder and persist across sessions:

- macOS: `~/Library/Application Support/openbook-lm/models/`
- Windows: `%APPDATA%\openbook-lm\models\`

---

## Supported document types

| Format              | Notes                                                           |
| ------------------- | --------------------------------------------------------------- |
| PDF (`.pdf`)        | Text extracted page by page; page numbers tracked for citations |
| Markdown (`.md`)    | Heading structure preserved; headings tracked for citations     |
| Plain text (`.txt`) | Line numbers tracked for citations                              |

Files larger than 50 MB are skipped. Hidden files/folders and `node_modules` are ignored.

---

## Install (pre-built, Apple Silicon)

The fastest way to get started — no Node.js or build tools needed.

**One-line installer:**

```bash
curl -fsSL https://raw.githubusercontent.com/sgrpanchal31/openbook-lm/main/scripts/install.sh | bash
```

Downloads the latest release, installs to `/Applications`, and removes the quarantine flag so the app opens without any "damaged" warning.

**Manual install (if you prefer):**

1. Download `openbook-lm-arm64.dmg` from the [latest release](https://github.com/sgrpanchal31/openbook-lm/releases/latest).
2. Open the DMG and drag `openbook-lm.app` to `/Applications`.
3. Run this once in Terminal:
   ```bash
   xattr -cr /Applications/openbook-lm.app
   ```
4. Open the app normally.

> **Why the Terminal step?** macOS marks every downloaded file as "quarantined." Because the app is self-signed rather than notarized, Gatekeeper shows "damaged" instead of offering an "open anyway" button. The `xattr` command removes that flag — the file is not actually damaged.

> **Apple Silicon only.** The pre-built release targets arm64 (M1/M2/M3/M4). Intel Mac users need to build from source (see below).

---

## Installation (from source)

### 1. Prerequisites

- [Node.js 18+](https://nodejs.org/) (20 recommended)
- npm (comes with Node.js)
- **macOS only:** Xcode Command Line Tools — run `xcode-select --install`
- **Windows only:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with "Desktop development with C++" workload (needed to compile native modules)

### 2. Clone the repository

```bash
git clone https://github.com/sgrpanchal31/openbook-lm.git
cd openbook-lm
```

### 3. Install dependencies

```bash
npm install
```

This also runs `electron-rebuild` automatically to compile native modules (LanceDB) against the correct Electron version. It may take a few minutes.

### 4. Run in development mode

```bash
npm run dev
```

The app window will open. First-run setup will guide you through picking a folder and downloading a model (~1–5 GB depending on your choice).

### 5. Build a distributable (optional)

```bash
npm run build
```

Output is in `out/`. To package as a `.app` or `.exe`, you can add `electron-builder` — see the TODOS for future packaging plans.

---

## First-run flow

1. **Pick a folder** — select any local folder containing your documents
2. **Indexing** — the app scans and chunks all supported files, then creates vector embeddings (runs once per folder; incremental on subsequent opens)
3. **Pick a model** — choose an LLM based on your RAM and speed preference
4. **Download** — the model downloads from HuggingFace (one-time; resumable if interrupted)
5. **Chat** — the three-pane interface opens: sources on the left, chat in the center, citation preview on the right

On subsequent launches, the app skips onboarding and loads your last notebook and model directly.

---

## Tech stack

| Layer         | Technology                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- |
| Desktop shell | [Electron](https://www.electronjs.org/)                                                      |
| Build tooling | [electron-vite](https://electron-vite.org/) + Vite + esbuild                                 |
| UI            | React 18 + TypeScript                                                                        |
| LLM inference | [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (llama.cpp bindings)           |
| Embeddings    | [@huggingface/transformers](https://huggingface.co/docs/transformers.js) — bge-small-en-v1.5 |
| Vector store  | [LanceDB](https://lancedb.github.io/lancedb/) (embedded, no separate server)                 |
| PDF parsing   | [pdfjs-dist](https://github.com/mozilla/pdfjs-dist)                                          |

---

## License

MIT
