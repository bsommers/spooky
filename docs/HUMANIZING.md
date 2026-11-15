# Humanizing (Phase 8)

`ghostwriter humanize` (and `generate --humanize`) rewrites a text so it scores lower on the local AI-likeness heuristic, while a mechanical guard keeps its numbers, names, quotes, code and URLs unchanged. It is a bounded, verified loop, not a detector bypass.

**Read this first: every "gain" below is measured against a weak, confounded scorer.** The local heuristic has a held-out AUC of 0.694 (95% interval 0.602 to 0.779) on the labeled corpus, a real signal of roughly 0.62 to 0.64 once the length confound is removed, and 54% of its weight sits on punctuation variety ([CALIBRATION.md](CALIBRATION.md)). A lower score from this tool means "the text now has the surface features this heuristic rewards", not "a detector would now call it human". No external detector has been tested; the claim is limited to the local scorer.

## What it does

```
text -> redact -> score -> at or below target? done
     -> pick the 2 worst-scoring features
     -> deterministic edits (cliche words, sentence rhythm, semicolon joins)
     -> one model pass (author profile + feature instructions), unless --no-llm
     -> for each candidate: confidentiality -> meaning guard -> rescore -> strictly lower? keep : revert
     -> repeat (at most maxIterations) -> confidentiality once more on the result
```

- **Bounded.** Stops at `targetScore` (default 0.3) or after `maxIterations` (default 3, at most 10). At most one model call per iteration, reported as `llmCalls`. The result is the best-scoring version seen, never merely the last.
- **Meaning guard (HUM-02).** `src/humanize/guard.ts` compares each candidate with the original: no number dropped, added or altered; no proper noun or acronym dropped, and no capitalized word the original never had; quoted spans, code, URLs and blockquotes byte-identical; code identifiers kept; word count within 0.5x to 2x. A violation reverts that edit and is counted in `guardRejections`; the trace names the violation by fixed code (`number_added`, `entity_dropped`, ...), never the text.
- **Confidentiality (HUM-03).** The input is redacted first, so the model never sees a secret. Every candidate (deterministic or model) is redacted again BEFORE it is scored or compared, and the final text once more. A secret the model invents is removed before the rescore; if the redaction cannot be shown to have run, the whole call fails closed (`FILTER_FAILED`). Code, URLs and blockquotes are protected spans: neither the deterministic edits nor the guard allow them to change.
- **Failure policy.** A model failure (error, empty or oversized answer) keeps the prior text, is recorded as a `llm_error` step with the error class only, and never throws (`onError: skip`).
- **Trace (HUM-04).** Every step records iteration, which features it targeted, score before and after, the per-feature deltas, whether the redaction changed the candidate, and the outcome (`improved`, `no_improvement`, `guard_rejected`, `llm_error`). The result adds `initialScore`, `finalScore`, `featuresBefore`/`featuresAfter`/`featureDeltas`, `iterations`, `llmCalls`, `guardRejections`.
- **Deterministic.** With a scripted model two runs are identical (tested). The deterministic edits are pure functions.

The deterministic edits are chosen because the local scorer rewards them: stock words from the scorer's own list are swapped for plain ones (`delve` to `dig`, `pivotal` to `key`, `notably` dropped), a long sentence is split at a clause conjunction or semicolon, and short adjacent sentences are joined with a semicolon (a punctuation class the scorer counts). Sentence-initial proper nouns are not tracked by the guard, and a negation flip or reordered facts would pass it; it proves the carriers of fact are intact, not that the meaning is.

## Use it

```bash
ghostwriter humanize draft.txt                        # deterministic edits, then up to 3 model passes
ghostwriter humanize draft.txt --no-llm --json        # deterministic only: no model call, no key
ghostwriter humanize draft.txt --author ann --target 0.25 --max-iterations 5
ghostwriter generate --author ann --persona executive draft.txt --humanize --target 0.3
curl -s -H 'Content-Type: application/json' -d '{"text":"...","llm":false}' http://127.0.0.1:8787/api/humanize
```

Library: `await engine.humanize(text, { authorId?, target?, maxIterations?, llm? })`, `engine.generate(a, p, text, { humanize: true, target? })`, or `new HumanizeFilter({ deps, ... })` for a custom post pipeline (not selectable in `filters.pipeline`; the engine itself applies the loop, with confidentiality last). MCP tool `humanize`; the OpenAPI document lists `POST /api/humanize`. Config (all optional): `"humanize": { "targetScore": 0.3, "maxIterations": 3 }`.

`humanize` is open-world (it sends the redacted text to the configured model) unless `llm` is false. Without a configured model, `humanize` still runs the deterministic edits and records the failed model pass.

## Measured results

Deterministic edits only (`--no-llm`), default target 0.3 and 3 iterations, over the labeled calibration corpus (140 AI and 141 human texts as stored). Regenerate with `npx vitest run tests/system/humanize-calibration.test.ts`; that test fails when this section drifts from the code.

<!-- humanize-calibration: ai=140 aiBefore=0.593 aiAfter=0.543 aiReachedTarget=4% aiImproved=55% aiGuardRejections=0/183 human=141 humanBefore=0.475 humanAfter=0.456 humanGuardRejections=7/118 testAucBefore=0.694 testAucAfter=0.595 wordsRatio=1.000 -->

| Measure | Value |
|---|---|
| AI texts: mean local score before / after | 0.593 / 0.543 (mean drop 0.050) |
| AI texts that reached the 0.3 target | 4% |
| AI texts whose score went down at all | 55% |
| Guard rejections, AI texts | 0 of 183 attempted edits |
| Human texts: mean score before / after | 0.475 / 0.456 |
| Guard rejections, human texts | 7 of 118 attempted edits |
| Held-out AUC, AI-after vs human-as-written | 0.595 (was 0.694 before humanizing) |
| Mean length after / before | 1.000 |

How to read it, plainly:

- The mean drop (0.050) is below the 0.1 the plan set as a bar; it is reported as measured and the fixtures were not tuned. Deterministic edits alone help about half of the texts and reach the target for almost none.
- The same edits also lower the scores of human texts, so part of the gain is moving along the heuristic, not removing anything that makes text machine-written. The held-out AUC falling from 0.694 to 0.595 says only that the heuristic separates the corpus less well afterwards.
- **Not measured:** the model pass against a real model (tests use a scripted model; there is no live-model run in this repository), and every external detector (none was configured or called). Do not read any number here as evidence about GPTZero, Turnitin, Originality or any other third-party detector. If you plug in a detector (`scorer.detectors`), score the before and after texts with `ghostwriter score --detector <name>` and publish what you find, including where it does not move.
