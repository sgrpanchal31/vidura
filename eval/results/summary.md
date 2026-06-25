# Retrieval Eval Summary

| Date       | Technique  | Dataset     | k   | Recall@k |   MRR | p50ms | p95ms | Hits    |
| ---------- | ---------- | ----------- | --- | -------: | ----: | ----: | ----: | ------- |
| 2026-05-20 | baseline   | longmemeval | 5   |    80.0% | 80.0% |    46 |   164 | 4/5     |
| 2026-06-23 | baseline   | domain      | 5   |    95.0% | 68.5% |    10 |   451 | 19/20   |
| 2026-06-24 | baseline   | domain      | 5   |    95.0% | 68.5% |     9 |   635 | 19/20   |
| 2026-06-24 | hybrid-rrf | domain      | 5   |    95.0% | 73.9% |    11 |   595 | 19/20   |
| 2026-06-24 | baseline   | longmemeval | 5   |    71.2% | 58.4% |    48 |    99 | 356/500 |
| 2026-06-24 | hybrid-rrf | longmemeval | 5   |    77.8% | 63.2% |    47 |    69 | 389/500 |
| 2026-06-24 | hybrid-rrf | domain      | 5   |    95.0% | 73.9% |    10 |   516 | 19/20   |
| 2026-06-24 | hybrid-rrf | domain      | 5   |    95.0% | 73.9% |    12 |   469 | 19/20   |
| 2026-06-24 | reranker   | domain      | 5   |    95.0% | 73.9% |    15 |    23 | 19/20   |
| 2026-06-24 | hybrid-rrf | longmemeval | 5   |    77.6% | 63.2% |    49 |    89 | 388/500 |
| 2026-06-24 | reranker   | longmemeval | 5   |    77.8% | 63.1% |    51 |    70 | 389/500 |
| 2026-06-25 | hybrid-rrf | longmemeval | 30  |    91.4% | 64.5% |    50 |   125 | 457/500 |
| 2026-06-25 | hybrid-rrf | domain      | 30  |   100.0% | 75.0% |    16 |    28 | 20/20   |
| 2026-06-25 | hybrid-rrf | longmemeval | 5   |    77.8% | 63.2% |    48 |   101 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   |    77.8% | 63.5% |    48 |    71 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   |    77.8% | 68.7% |   399 |   545 | 389/500 |
| 2026-06-25 | reranker   | longmemeval | 5   |    83.4% | 72.8% |  2136 |  2442 | 417/500 |
| 2026-06-25 | reranker   | domain      | 5   |   100.0% | 83.5% |  2361 |  3053 | 20/20   |
