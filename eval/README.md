# Retrieval Evaluation Harness

Tests how accurately Vidura retrieves the right chunks of text for a given question.
Results live in `eval/results/summary.md` — one row per technique×dataset run.

## Quick start

```bash
# 1. Install dependencies (first time only)
npm install

# 2. Download the LongMemEval dataset (~300MB, one-time)
npm run eval -- --download

# 3. Run baseline
npm run eval -- --dataset longmemeval --technique baseline --limit 50
#   --limit 50 runs only 50 queries for a quick check (full=500)

# 4. See results
cat eval/results/summary.md
```

## Commands

```bash
# Run one technique
npm run eval -- --dataset longmemeval --technique baseline

# Compare multiple techniques in sequence
npm run eval -- --dataset longmemeval --technique baseline,rerank --topk 5

# Quick 20-query smoke run
npm run eval -- --dataset longmemeval --technique baseline --limit 20
```

## What the numbers mean

| Metric          | Plain English                                                              |
| --------------- | -------------------------------------------------------------------------- |
| **Recall@k**    | Did the right chunk appear anywhere in the top k? Higher = better.         |
| **MRR**         | How high did the right chunk rank? 1.0 = always first, 0.2 = always fifth. |
| **p50 latency** | Median time per query in milliseconds.                                     |
| **p95 latency** | Worst-case time (slowest 5% of queries).                                   |

## Datasets

### longmemeval

Chat/memory session data. Tests retrieval across conversational sessions. Requires a one-time download (~300MB).

### domain

Hand-built dataset anchored to the v1 wedge use case: a researcher with a folder of 50+ academic ML papers. See `eval/datasets/domain/PERSONA.md` for full context.

- **Corpus**: 55 papers as plain text (10 signal papers with QA pairs + 45 noise papers for realistic folder load)
- **QA pairs**: 20 questions targeting specific facts — BLEU scores, parameter counts, method descriptions, benchmark results
- **No download needed** — corpus files are committed to the repo

```bash
npm run eval -- --dataset domain --technique baseline
```

Each QA pair stores a `meta.answer` ground-truth string ready for future RAGAS integration.

## Adding a new technique

1. Create `eval/techniques/<name>.ts` that exports a class implementing `RetrievalTechnique`.
2. Register it in `eval/cli.ts` under `TECHNIQUES`.
3. Run: `npm run eval -- --dataset longmemeval --technique <name>`

## File layout

```
eval/
  harness/
    types.ts      — shared interfaces (RetrievalTechnique, DatasetEntry, etc.)
    runner.ts     — orchestrates dataset × technique → results
    metrics.ts    — Recall@k, MRR, latency math
    embedder.ts   — simple HuggingFace embedder (no Electron, no worker threads)
    corpus.ts     — builds LanceDB index from a folder of docs
    report.ts     — writes JSON + appends to summary.md
  techniques/
    baseline.ts   — current Vidura retrieval (vector-only, bge-small, top-k)
    ...           — add more here (Phase 3)
  datasets/
    longmemeval/
      download.ts — fetch from HuggingFace
      loader.ts   — parse into DatasetEntry[]
      data/       — gitignored (downloaded files + extracted corpus)
    domain/
      PERSONA.md  — wedge use case rationale
      loader.ts   — loads qa.json + returns corpusDir
      qa.json     — 20 QA pairs with expectedSourceFiles + meta.answer
      corpus/     — 55 .txt paper summaries (committed)
  results/
    summary.md    — committed: running comparison table
    *.json        — gitignored: per-run raw data
  cli.ts          — entry point
```
