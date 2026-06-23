# Domain Eval Persona: Literature Hoarder

## v1 Wedge User

A researcher or graduate student who downloads academic papers to a local folder over time — a `papers/` or `literature/` directory with 50–200+ PDFs. They've hit one of NotebookLM's walls (50-source cap, reluctance to upload sensitive research, friction of manual per-file upload) and want to query their entire collection at once.

**What they ask**: Specific, verifiable questions — exact numbers from results sections, methodological details, comparisons between papers. "What dataset did they use?", "What was the baseline?", "Which paper introduced X?"

**Why this wedge for v1 pipeline decisions**: Queries are precise enough to score objectively (right document retrieved or not). The corpus is dense with similar-topic papers, which tests retrieval disambiguation — the hardest retrieval case for an embedding-only system.

## Dataset

- **Corpus**: 55 academic ML papers as plain text (10 "signal" papers with QA pairs + 45 noise papers simulating a realistic folder)
- **QA pairs**: 20 hand-written questions, 2 per signal paper, each with an `expectedSourceFiles` pointer and a `meta.answer` ground-truth string
- **Signal papers**: Transformer, BERT, GPT-3, LoRA, RAG, LLaMA, Chain-of-Thought, InstructGPT, FlashAttention, Scaling Laws
- **Noise papers**: Diverse ML topics (CV, RL, optimization, self-supervised learning, etc.) to simulate a real folder and stress-test retrieval

## Notes

This persona is a v1 anchor, not a permanent product definition. As openbook-lm generalizes, additional dataset personas (second brain / Obsidian vault, developer docs, legal documents) should be added as separate dataset entries.

The `meta.answer` field in `qa.json` stores ground-truth answers for future RAGAS integration — no schema changes will be needed when RAGAS is added.
