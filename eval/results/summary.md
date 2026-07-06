# Retrieval Eval Summary

| Date       | Technique  | Dataset     | k   | Embed     | Recall@k |   MRR | p50ms | p95ms | Hits    |
| ---------- | ---------- | ----------- | --- | --------- | -------: | ----: | ----: | ----: | ------- |
| 2026-05-20 | baseline   | longmemeval | 5   | bge-small |    80.0% | 80.0% |    46 |   164 | 4/5     |
| 2026-06-23 | baseline   | domain      | 5   | bge-small |    95.0% | 68.5% |    10 |   451 | 19/20   |
| 2026-06-24 | baseline   | domain      | 5   | bge-small |    95.0% | 68.5% |     9 |   635 | 19/20   |
| 2026-06-24 | hybrid-rrf | domain      | 5   | bge-small |    95.0% | 73.9% |    11 |   595 | 19/20   |
| 2026-06-24 | baseline   | longmemeval | 5   | bge-small |    71.2% | 58.4% |    48 |    99 | 356/500 |
| 2026-06-24 | hybrid-rrf | longmemeval | 5   | bge-small |    77.8% | 63.2% |    47 |    69 | 389/500 |
| 2026-06-24 | hybrid-rrf | domain      | 5   | bge-small |    95.0% | 73.9% |    10 |   516 | 19/20   |
| 2026-06-24 | hybrid-rrf | domain      | 5   | bge-small |    95.0% | 73.9% |    12 |   469 | 19/20   |
| 2026-06-24 | reranker   | domain      | 5   | bge-small |    95.0% | 73.9% |    15 |    23 | 19/20   |
| 2026-06-24 | hybrid-rrf | longmemeval | 5   | bge-small |    77.6% | 63.2% |    49 |    89 | 388/500 |
| 2026-06-24 | reranker   | longmemeval | 5   | bge-small |    77.8% | 63.1% |    51 |    70 | 389/500 |
| 2026-06-25 | hybrid-rrf | longmemeval | 30  | bge-small |    91.4% | 64.5% |    50 |   125 | 457/500 |
| 2026-06-25 | hybrid-rrf | domain      | 30  | bge-small |   100.0% | 75.0% |    16 |    28 | 20/20   |
| 2026-06-25 | hybrid-rrf | longmemeval | 5   | bge-small |    77.8% | 63.2% |    48 |   101 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   | bge-small |    77.8% | 63.5% |    48 |    71 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   | bge-small |    77.8% | 68.7% |   399 |   545 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   | bge-small |    83.4% | 72.8% |  2136 |  2442 | 417/500 |
| 2026-06-25 | reranker   | domain      | 5   | bge-small |   100.0% | 83.5% |  2361 |  3053 | 20/20   |
| 2026-06-25 | baseline   | domain      | 5   | qwen3     |    95.0% | 61.2% |    83 |   269 | 19/20   |
| 2026-06-25 | hybrid-rrf | domain      | 5   | qwen3     |    95.0% | 66.4% |    61 |    84 | 19/20   |
| 2026-06-25 | reranker   | domain      | 5   | qwen3     |   100.0% | 67.5% |    68 |   107 | 20/20   |
| 2026-06-25 | baseline   | longmemeval | 5   | qwen3     |    73.6% | 59.6% |    96 |   149 | 368/500 |
| 2026-06-25 | hybrid-rrf | longmemeval | 5   | qwen3     |    78.8% | 65.4% |   100 |   143 | 394/500 |
| 2026-06-25 | reranker   | longmemeval | 5   | qwen3     |    91.6% | 68.2% |   110 |   265 | 458/500 |

# Answer-Level Eval: Agent Pipeline vs Old RAG Pipeline (eval/agent/)

Measures generated ANSWERS (not retrieval): key-fact hit, token F1 vs gold, citation validity
(% of cited passages containing the fact), end-to-end latency. Domain dataset, 20 single-hop +
10 multi-hop questions, gemma4-e4b, reranker on, run headless via `npx tsx eval/agent/runner.mts`.

| Date       | Arm           | Subset   | n   | Hit | F1    | CitValid | p50s |
| ---------- | ------------- | -------- | --- | --- | ----- | -------- | ---- |
| 2026-07-06 | old rag       | all      | 30  | 37% | 0.353 | 0.45     | 20.4 |
| 2026-07-06 | agent (tuned) | all      | 30  | 47% | 0.359 | 0.48     | 36.1 |
| 2026-07-06 | old rag       | simple   | 20  | 25% | 0.327 | 0.42     | 20.4 |
| 2026-07-06 | agent (tuned) | simple   | 20  | 40% | 0.324 | 0.47     | 35.5 |
| 2026-07-06 | old rag       | multihop | 10  | 60% | 0.405 | 0.50     | 21.9 |
| 2026-07-06 | agent (tuned) | multihop | 10  | 60% | 0.429 | 0.50     | 44.8 |

Tuning history (agent arm, all-subset): untuned 43% hit / 0.287 F1 / 43.8s p50 →
concise-answer + tight decisions 43% / 0.372 / 39.8 → + answer-at-first-decision nudge
47% / 0.359 / 36.1. Latency floor is structural: each grammar-constrained decision with a
visible thought costs 3-6s of generation on local hardware.

Known corpus issue affecting both arms: chunker splits parents mid-sentence, detaching
facts from their subjects (issue #56).
