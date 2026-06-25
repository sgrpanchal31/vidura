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
