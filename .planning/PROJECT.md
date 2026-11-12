# Spooky: dual-axis ghostwriter engine

## Goal
A TypeScript engine that drafts text in a **source author's voice** (axis 1: stylometric profile) for a **target audience** (axis 2: persona constraints), wrapped in an inline, pluggable **filter pipeline**: confidentiality redaction before the LLM call, and style/humanizing edits after it. Deliverable: a library plus a CLI (`ghostwriter generate --author X --persona Y < input`) with a test suite wired to `scripts/verify.sh`.

## Source
`dual-axis-ghostwriter.md` (Gemini export). Only the filter pipeline and TS layout survive in it; the earlier dual-axis design turns are missing. Everything about ingestion, stylometry, vector store and LLM is **decided in this plan** (see Decisions), not inherited.

## Motivation (measured)
No measurements exist. The source code has known defects that this plan must not carry over:
1. `FilterResult.modified: bool` is not a TS type (compile error).
2. `AntiAIFilter` declares `bannedPhrases` but assigns/reads `this.banned_phrases` (compile error).
3. Regexes with `/g` flag used with `.test()` then `.replace()` keep `lastIndex` state, so every second call skips matches.
4. `ConfidentialityFilter` builds `new RegExp(term)` from blocklist entries unescaped (regex injection, and throws on `(`).
5. Secret patterns are single-match shapes: no `ghp_`, `sk-`, `xox`, JWT, full PEM block (only the header line is redacted, key body leaks), non-`g` patterns redact only the first hit.
6. `BaseFilter.process` is sync; the doc's own prose calls for an asynchronous middleware.
7. Filter exceptions are unhandled; a crashing confidentiality filter must fail closed, not pass text through.
8. Removing banned phrases leaves broken casing/punctuation (`"Furthermore, we ..."` -> `"we ..."`).
9. `TargetPersonaConfig.bannedPhrases` is defined but nothing enforces it.

## Decisions (assumptions, change here if wrong)
| ID | Decision | Why |
|---|---|---|
| D1 | Node 20+, TypeScript strict, ESM, `vitest` | Smallest standard toolchain |
| D2 | LLM behind `LlmClient` interface with two adapters: `AnthropicClient` (`@anthropic-ai/sdk`) and `OpenAICompatClient` (any `/v1/chat/completions` server: OpenAI, Ollama, vLLM, LM Studio, OpenRouter; configurable `baseUrl`, `apiKeyEnv`, `model`). Uses built-in `fetch`, no `openai` package. `MockLlmClient` is the test default | Provider-agnostic, offline tests |
| D3 | Vector store behind `VectorStore` interface; default `InMemoryVectorStore` + JSON file persistence; no vector DB dependency in v1 | "No new deps" until measured need |
| D4 | Embeddings behind `Embedder` interface; v1 default is a deterministic hashed bag-of-words embedder (offline); real embedder is a later adapter | Determinism, offline tests |
| D5 | Stylometry is computed locally (no LLM): sentence length, lexical density, punctuation, hedging, active/passive heuristic, transitions | Matches `StylometricProfile` |
| D6 | Confidentiality runs **pre** on user input and also **post** on LLM output; it fails closed | Output can echo or invent secrets |
| D7 | v1 anti-AI filter is a *style editor* (remove cliches, vary rhythm, repair grammar). Detector scoring and score-targeted humanizing are deferred to milestone v2 (below) | Scope control |

## Out of scope (v1)
Web UI, multi-user auth, real vector DB, fine-tuning, streaming output, LLM-based humanizer pass, detector scoring (milestone v2).

## Constraints
- No dependencies beyond: `typescript`, `vitest`, `@anthropic-ai/sdk`, `zod`, `commander` (OpenAI-compatible adapter uses `fetch`).
- Every filter is pure given `(text, ctx)`; no global mutable state; no stateful regex.
- Pipeline output is byte-identical across runs for the same input (determinism).
- Redaction placeholders are deterministic and typed (`[REDACTED:aws_key]`).
