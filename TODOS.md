# openbook-lm TODOs

## Conditional (check during build)

### TODO-1: Reranker download in first-run flow
**What:** If the eval (D8-10) chooses retrieval layer 3 (hybrid + reranker), add a `bge-reranker-base` (~280MB) download step to the first-run flow with a license modal (LGPL-3.0).
**Why:** Layer 3 is not chosen until the eval runs. If it wins, the first-run flow needs an extra download that isn't currently specced.
**Where to start:** `electron/services/models.ts` (download logic already exists for LLM — reuse the same Range-resume + SHA-warn pattern). `electron/main.ts` first-run flow. Add `acceptedReranker: boolean` to `prefs.json` schema.
**Depends on:** eval lock (D8-10).

### TODO-2: Validate OOM crash behavior in node-llama-cpp
**What:** During D8-10 when `node-llama-cpp` is integrated, deliberately trigger an OOM by loading a model too large for available RAM. Observe: does it throw a JS error, hang indefinitely, or kill the Electron process?
**Why:** OOM handling in the plan says "graceful error, not crash" but native llama.cpp allocations can crash or hang below JavaScript's error handling. The right fix (watchdog timer, process restart, or error boundary) depends on actual crash behavior.
**Where to start:** `electron/services/inference.ts`. Add a 30-second watchdog timer around the model load call. If it fires, send `chat:error` IPC with "Not enough memory to run this model."
**Depends on:** node-llama-cpp integrated (D8-10).

## v1.1 (after v1.0 launches)

### TODO-3: PDF source panel with real page rendering
**What:** Upgrade the source panel from "display extracted text" (v1) to rendering the actual PDF page with a highlight box over the matched passage.
**Why:** This is what NotebookLM does. V1 shows extracted text (readable but unformatted). V1.1 shows the actual PDF page.
**Where to start:** Add `pdfjs-dist` to the renderer bundle (`src/`). At chunk time (`electron/services/ingest/pdf.ts`), store character offsets alongside `pageNumber`. Source panel component: render PDF page via `pdfjs-dist`, compute highlight box from character offsets.
**Depends on:** v1.0 shipped and stable.
