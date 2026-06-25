# RAG Improvement Workflow

Any change to the retrieval pipeline must be eval-gated before it touches production code. This doc defines the process and tracks the current production baseline.

## Current production technique

**Technique:** hybrid-rrf + bge-reranker-v2-m3 (GGUF, Q8_0, via node-llama-cpp)  
Reranking is user-opt-in (Settings → Retrieval → BGE Reranker). When disabled, falls back to hybrid-rrf.

| Dataset            | Recall@5 | MRR   | Latency p50 |
| ------------------ | -------- | ----- | ----------- |
| domain             | 100.0%   | 83.5% | ~2.4s       |
| longmemeval oracle | 83.4%    | 72.8% | ~2.1s       |

**Previous baseline (hybrid-rrf only):**

| Dataset            | Recall@5 | MRR   |
| ------------------ | -------- | ----- |
| domain             | 95.0%    | 73.9% |
| longmemeval oracle | 77.8%    | 63.2% |

Update this section whenever a new technique ships.

## Process

Every new retrieval technique (reranker, MMR, HyDE, etc.) goes through these steps in order:

### 1. Implement as an eval technique

Create `eval/techniques/<name>.ts` implementing the `RetrievalTechnique` interface:

```typescript
interface RetrievalTechnique {
  name: string
  setup(ctx: RetrievalContext): Promise<void> // build index, warm models
  retrieve(query: string, topK: number): Promise<RetrievedChunk[]>
  teardown?(): Promise<void>
}
```

See `eval/techniques/baseline.ts` for the simplest example, `hybrid-rrf.ts` for a more involved one.

### 2. Register it in the CLI

Add to the `TECHNIQUES` map in `eval/cli.ts`:

```typescript
'your-technique': yourTechnique,
```

### 3. Run eval on both datasets

```bash
# Our own domain Q&A (most relevant to real usage)
npm run eval -- --dataset domain --technique baseline,<name> --topk 5

# LongMemEval oracle (fast general benchmark, ~15 questions)
npm run eval -- --dataset longmemeval --technique baseline,<name> --topk 5 --variant oracle
```

Use `--limit 20` for a quick smoke test during development before a full run.

### 4. Gate on results

Only update the production pipeline if the new technique:

- Beats the current baseline on both datasets, OR
- Wins clearly on one without regressing on the other

If it only helps on one dataset and hurts on the other, dig into which question types are affected before deciding.

### 5. Ship and record

Update `store.ts`, `rag.ts`, `indexer.ts` (or wherever the production path is). Then update the **Current production technique** section above with the new technique name and its Recall@5 + MRR scores on both datasets.

## Reranker history

### What was tried and failed

`Xenova/ms-marco-MiniLM-L-6-v2` (ONNX, 23 MB): neutral result. Trained on web search queries, wrong domain for document Q&A.

### What shipped

`bge-reranker-v2-m3` Q8_0 GGUF (606 MB) via node-llama-cpp `LlamaRankingContext.rankAll()`.

Key architecture: rerank the full 30-candidate pool BEFORE `dedupeByParent`, not after. Reranking 8 already-deduped parents misses the 69 questions where the gold chunk is at ranks 6-30.

| Dataset            | hybrid-rrf @5 | reranker @5        | Delta           |
| ------------------ | ------------- | ------------------ | --------------- |
| domain             | 95.0% / 73.9% | **100.0% / 83.5%** | +5pp / +9.6pp   |
| longmemeval oracle | 77.8% / 63.2% | **83.4% / 72.8%**  | +5.6pp / +9.6pp |

Latency: ~2.1-2.4s added per query (30 forward passes at p50). Acceptable for local app.

## Running a full benchmark

```bash
# Full LongMemEval 's' variant (278 MB, ~500 questions) — slow but authoritative
npm run eval -- --dataset longmemeval --technique baseline,<name> --topk 5 --variant s

# Download datasets if not yet present
npm run eval -- --download
```

## Metrics reference

| Metric          | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| Recall@K        | Fraction of questions where the correct source appeared in the top K results       |
| MRR             | Mean Reciprocal Rank — rewards finding the right source at rank 1 more than rank 5 |
| Latency p50/p95 | Retrieval time in ms (excludes LLM generation)                                     |
